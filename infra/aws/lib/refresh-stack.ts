import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { DATA_LAYOUT } from "./data-stack.js";
import { PythonDepsLayer } from "./python-deps-layer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REFRESH_LAMBDA_DIR = path.join(here, "..", "lambdas", "refresh");
/**
 * Allow-list: tests, caches, the local runner and tooling config never reach
 * the functions. Every module a handler imports must be listed here.
 */
export const REFRESH_CODE_EXCLUDE = [
  "*",
  ".*",
  "!refresh.py",
  "!early_warning.py",
  "!alerts.py",
  "!goes_watch.py",
  "!targeting.py",
  "!subscriptions.py",
  "!dynamo_store.py",
  "!telegram_bot.py",
  "!notifier.py",
  "!subscriber_alerts.py",
  "!alerts_api.py",
];

function logGroupFor(scope: Construct, id: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

/** Suomi NPP stopped on 2026-11-02; NOAA-20 and NOAA-21 carry VIIRS now. */
export const FIRMS_SOURCES = ["MODIS_NRT", "VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"];

/**
 * Alert channel settings, created by hand in Parameter Store (standard tier):
 * e-mail sender and comma-separated recipients as String, Telegram bot token
 * and chat id as SecureString. A channel whose parameters are missing is
 * skipped at run time, so none of them has to exist for the stack to deploy.
 */
export const ALERT_PARAMETERS = {
  emailFrom: "/aeros/alerts/email-from",
  emailTo: "/aeros/alerts/email-to",
  telegramToken: "/aeros/alerts/telegram-token",
  telegramChatId: "/aeros/alerts/telegram-chat-id",
} as const;

/**
 * Parameters of the subscriptions, created by hand like the others: the
 * Telegram webhook secret (SecureString, made up by whoever registers the
 * webhook) and the bot's username (String, no @, public by nature).
 */
export const SUBSCRIPTION_PARAMETERS = {
  telegramWebhookSecret: "/aeros/alerts/telegram-webhook-secret",
  telegramBot: "/aeros/alerts/telegram-bot",
} as const;

/** What the subscriptions code does to the table: nothing else is granted. */
const TABLE_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:PutItem",
  "dynamodb:DeleteItem",
  "dynamodb:Scan",
];

export function grantSubscriptionsTable(fn: lambda.Function, table: dynamodb.ITable): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: TABLE_ACTIONS, resources: [table.tableArn] }),
  );
}

/** GetParameter on exactly these parameters, for whichever function reads them. */
export function grantParameters(
  stack: Stack,
  fn: lambda.Function,
  names: readonly string[],
): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: names.map((name) =>
        stack.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
      ),
    }),
  );
}

export interface RefreshStackProps extends StackProps {
  readonly dataBucket: s3.IBucket;
  /** Where the subscriptions live; the daily run notifies from it. */
  readonly subscriptionsTable: dynamodb.ITable;
  /**
   * SecureString parameter (standard tier, AWS-managed key) with the FIRMS
   * MAP_KEY, created by hand: CloudFormation cannot create SecureStrings, and
   * the value must never pass through the repository or the template.
   */
  readonly firmsMapKeyParameter: string;
  readonly firmsArea: string;
  /** 0 leaves the function unreserved. */
  readonly reservedConcurrency: number;
  /** Linked from every alert message. */
  readonly webUrl: string;
  readonly alertRegionName: string;
  /** Verified SES identity alerts are sent from; no SES permission without it. */
  readonly alertEmailIdentity?: string;
}

/**
 * Daily run: download the last week of FIRMS NRT files into raw/firms/, then
 * publish derived/early_warning.json from the VIIRS days against the
 * harmonized climatology. One small invocation a day stays far inside the
 * always-free Lambda allowance.
 */
export class RefreshStack extends Stack {
  readonly handler: lambda.Function;
  readonly goesWatch: lambda.Function;
  readonly telegramWebhook: lambda.Function;
  readonly layer: PythonDepsLayer;

  constructor(scope: Construct, id: string, props: RefreshStackProps) {
    super(scope, id, props);

    const mapKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, "FirmsMapKey", {
      parameterName: props.firmsMapKeyParameter,
    });

    const logGroup = logGroupFor(this, "RefreshHandlerLogs");
    this.layer = new PythonDepsLayer(this, "PythonDeps");

    this.handler = new lambda.Function(this, "RefreshHandler", {
      description: "Daily FIRMS NRT download, early warning and fire alerts",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "refresh.handler",
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, {
        exclude: REFRESH_CODE_EXCLUDE,
      }),
      layers: [this.layer],
      memorySize: 512,
      timeout: Duration.minutes(5),
      // One run at a time is all a daily job needs, and it caps a runaway retry loop.
      reservedConcurrentExecutions: props.reservedConcurrency || undefined,
      logGroup,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        RAW_PREFIX: DATA_LAYOUT.rawFirmsPrefix,
        FIRMS_MAP_KEY_PARAMETER: props.firmsMapKeyParameter,
        FIRMS_AREA: props.firmsArea,
        FIRMS_SOURCES: FIRMS_SOURCES.join(","),
        // The early warning reads the last seven complete days.
        FIRMS_DAYS_BACK: "7",
        EARLY_WARNING_KEY: DATA_LAYOUT.earlyWarningKey,
        CELLS_KEY: DATA_LAYOUT.cellsKey,
        HOTSPOTS_KEY: DATA_LAYOUT.hotspotsKey,
        DUCKDB_HTTPFS: "/opt/duckdb/httpfs.duckdb_extension",
        ALERT_STATE_KEY: DATA_LAYOUT.alertStateKey,
        ALERT_WEB_URL: props.webUrl,
        ALERT_REGION_NAME: props.alertRegionName,
        ALERT_EMAIL_FROM_PARAMETER: ALERT_PARAMETERS.emailFrom,
        ALERT_EMAIL_TO_PARAMETER: ALERT_PARAMETERS.emailTo,
        ALERT_TELEGRAM_TOKEN_PARAMETER: ALERT_PARAMETERS.telegramToken,
        ALERT_TELEGRAM_CHAT_PARAMETER: ALERT_PARAMETERS.telegramChatId,
        SUBSCRIPTIONS_TABLE: props.subscriptionsTable.tableName,
        WIND_KEY: DATA_LAYOUT.windKey,
        FIRE_WEATHER_KEY: DATA_LAYOUT.fireWeatherKey,
      },
    });
    // The parameter uses the AWS-managed aws/ssm key, whose key policy lets
    // Parameter Store decrypt for any principal allowed to read the parameter.
    mapKey.grantRead(this.handler);
    props.dataBucket.grantPut(this.handler, `${DATA_LAYOUT.rawFirmsPrefix}*`);
    props.dataBucket.grantPut(this.handler, DATA_LAYOUT.earlyWarningKey);
    props.dataBucket.grantRead(this.handler, `${DATA_LAYOUT.harmonizedPrefix}*`);
    props.dataBucket.grantRead(this.handler, DATA_LAYOUT.alertStateKey);
    props.dataBucket.grantPut(this.handler, DATA_LAYOUT.alertStateKey);
    // Optional extras of the subscriber messages, read when they exist.
    props.dataBucket.grantRead(this.handler, DATA_LAYOUT.windKey);
    props.dataBucket.grantRead(this.handler, DATA_LAYOUT.fireWeatherKey);
    grantSubscriptionsTable(this.handler, props.subscriptionsTable);

    this.grantAlerts(this.handler, props);

    this.goesWatch = this.goesWatchFunction(props, logGroupFor(this, "GoesWatchLogs"));
    this.telegramWebhook = this.telegramWebhookFunction(props, logGroupFor(this, "TelegramWebhookLogs"));

    // 06:00 UTC: after the night passes over South America are in the NRT feed.
    new events.Rule(this, "DailyRefresh", {
      description: "Pull the latest FIRMS NRT detections and publish the early warning",
      schedule: events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(this.handler, { retryAttempts: 2 })],
    });
  }

  /**
   * Every 10 minutes: read the newest GOES-19 fire scans from NOAA's public
   * bucket, publish derived/goes_latest.json and tell people about a fire
   * that persists in the study cells. 4,320 short runs a month stay inside
   * the always-free Lambda allowance, and the scans themselves are read from
   * NOAA, never copied into the data bucket.
   */
  private goesWatchFunction(props: RefreshStackProps, logGroup: logs.LogGroup): lambda.Function {
    const fn = new lambda.Function(this, "GoesWatchHandler", {
      description: "GOES-19 fire pixels every 10 minutes and fast fire alerts",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "goes_watch.handler",
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, { exclude: REFRESH_CODE_EXCLUDE }),
      layers: [this.layer],
      // A full-disk fire mask is 5424 x 5424 int16, about 59 MB per scan.
      memorySize: 512,
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: props.reservedConcurrency || undefined,
      logGroup,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        FIRMS_AREA: props.firmsArea,
        GOES_LATEST_KEY: DATA_LAYOUT.goesLatestKey,
        CELLS_KEY: DATA_LAYOUT.cellsKey,
        DUCKDB_HTTPFS: "/opt/duckdb/httpfs.duckdb_extension",
        ALERT_STATE_KEY: DATA_LAYOUT.alertStateKey,
        GOES_ALERT_STATE_KEY: DATA_LAYOUT.goesAlertStateKey,
        ALERT_WEB_URL: props.webUrl,
        ALERT_REGION_NAME: props.alertRegionName,
        ALERT_EMAIL_FROM_PARAMETER: ALERT_PARAMETERS.emailFrom,
        ALERT_EMAIL_TO_PARAMETER: ALERT_PARAMETERS.emailTo,
        ALERT_TELEGRAM_TOKEN_PARAMETER: ALERT_PARAMETERS.telegramToken,
        ALERT_TELEGRAM_CHAT_PARAMETER: ALERT_PARAMETERS.telegramChatId,
      },
    });
    props.dataBucket.grantPut(fn, DATA_LAYOUT.goesLatestKey);
    props.dataBucket.grantRead(fn, DATA_LAYOUT.cellsKey);
    props.dataBucket.grantRead(fn, DATA_LAYOUT.goesAlertStateKey);
    props.dataBucket.grantPut(fn, DATA_LAYOUT.goesAlertStateKey);
    this.grantAlerts(fn, props);

    new events.Rule(this, "GoesWatchSchedule", {
      description: "Read the newest GOES-19 fire scans and publish the active fires",
      schedule: events.Schedule.rate(Duration.minutes(10)),
      // A missed run is replaced by the next one ten minutes later.
      targets: [new targets.LambdaFunction(fn, { retryAttempts: 0 })],
    });
    return fn;
  }

  /**
   * Telegram's webhook: the bot's door. Telegram cannot sign requests for
   * CloudFront, so this is a public function URL and the secret header
   * Telegram sends with every call is its only protection; the handler
   * refuses everything when the secret parameter does not exist.
   */
  private telegramWebhookFunction(
    props: RefreshStackProps,
    logGroup: logs.LogGroup,
  ): lambda.Function {
    const fn = new lambda.Function(this, "TelegramWebhookHandler", {
      description: "Telegram bot webhook: confirms and ends alert subscriptions",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "alerts_api.webhook",
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, { exclude: REFRESH_CODE_EXCLUDE }),
      layers: [this.layer],
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup,
      environment: {
        SUBSCRIPTIONS_TABLE: props.subscriptionsTable.tableName,
        FIRMS_AREA: props.firmsArea,
        ALERT_WEB_URL: props.webUrl,
        ALERT_TELEGRAM_TOKEN_PARAMETER: ALERT_PARAMETERS.telegramToken,
        ALERT_TELEGRAM_WEBHOOK_SECRET_PARAMETER: SUBSCRIPTION_PARAMETERS.telegramWebhookSecret,
      },
    });
    grantSubscriptionsTable(fn, props.subscriptionsTable);
    grantParameters(this, fn, [
      ALERT_PARAMETERS.telegramToken,
      SUBSCRIPTION_PARAMETERS.telegramWebhookSecret,
    ]);
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // Functions URLs created from late 2025 need both permissions to be public.
    fn.addPermission("PublicInvokeViaUrl", {
      principal: new iam.AnyPrincipal(),
      action: "lambda:InvokeFunction",
      invokedViaFunctionUrl: true,
    });
    new CfnOutput(this, "TelegramWebhookUrl", {
      value: url.url,
      description: "Pass it to Telegram's setWebhook together with a secret_token",
    });
    return fn;
  }

  /** Exactly what sending an alert needs, for whichever function sends it. */
  private grantAlerts(fn: lambda.Function, props: RefreshStackProps): void {
    // Exactly the four alert parameters, read with GetParameter only. Like the
    // MAP_KEY they use the AWS-managed aws/ssm key, so no KMS grant is needed.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: Object.values(ALERT_PARAMETERS).map((name) =>
          this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.slice(1) }),
        ),
      }),
    );
    // SES sending is part of the Free plan. The grant names only the sender
    // identity, so the function cannot send as anyone else. In sandbox mode
    // every recipient must be a verified identity too (see alerts.py).
    if (props.alertEmailIdentity) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [
            this.formatArn({
              service: "ses",
              resource: "identity",
              resourceName: props.alertEmailIdentity,
            }),
          ],
        }),
      );
    }
  }
}
