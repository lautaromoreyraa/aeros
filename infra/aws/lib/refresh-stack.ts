import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
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

export interface RefreshStackProps extends StackProps {
  readonly dataBucket: s3.IBucket;
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

  constructor(scope: Construct, id: string, props: RefreshStackProps) {
    super(scope, id, props);

    const mapKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, "FirmsMapKey", {
      parameterName: props.firmsMapKeyParameter,
    });

    const logGroup = new logs.LogGroup(this, "RefreshHandlerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.handler = new lambda.Function(this, "RefreshHandler", {
      description: "Daily FIRMS NRT download, early warning and fire alerts",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "refresh.handler",
      // Allow-list: tests, caches and tooling config never reach the function.
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, {
        exclude: ["*", ".*", "!refresh.py", "!early_warning.py", "!alerts.py"],
      }),
      layers: [new PythonDepsLayer(this, "PythonDeps")],
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

    // Exactly the four alert parameters, read with GetParameter only. Like the
    // MAP_KEY they use the AWS-managed aws/ssm key, so no KMS grant is needed.
    this.handler.addToRolePolicy(
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
      this.handler.addToRolePolicy(
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

    // 06:00 UTC: after the night passes over South America are in the NRT feed.
    new events.Rule(this, "DailyRefresh", {
      description: "Pull the latest FIRMS NRT detections and publish the early warning",
      schedule: events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(this.handler, { retryAttempts: 2 })],
    });
  }
}
