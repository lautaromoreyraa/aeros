import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { DATA_LAYOUT } from "./data-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REFRESH_LAMBDA_DIR = path.join(here, "..", "lambdas", "refresh");

export interface RefreshStackProps extends StackProps {
  readonly dataBucket: s3.IBucket;
  /** Name of an existing secret holding the FIRMS MAP_KEY; the value never passes through CDK. */
  readonly firmsSecretName: string;
  readonly firmsArea: string;
}

/**
 * Daily pull of the FIRMS near-real-time files into the raw prefix of the
 * data bucket. The function only uses the standard library and boto3, which
 * the Lambda runtime ships, so the asset is the source folder as is.
 */
export class RefreshStack extends Stack {
  readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props: RefreshStackProps) {
    super(scope, id, props);

    const secret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "FirmsMapKey",
      props.firmsSecretName,
    );

    const logGroup = new logs.LogGroup(this, "RefreshHandlerLogs", {
      retention: logs.RetentionDays.THREE_MONTHS,
    });

    this.handler = new lambda.Function(this, "RefreshHandler", {
      description: "Daily FIRMS NRT download into the aeros data bucket",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "refresh.handler",
      // Allow-list: tests, caches and tooling config never reach the function.
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, { exclude: ["*", ".*", "!refresh.py"] }),
      memorySize: 256,
      timeout: Duration.minutes(5),
      logGroup,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        RAW_PREFIX: DATA_LAYOUT.rawFirmsPrefix,
        FIRMS_SECRET_NAME: props.firmsSecretName,
        FIRMS_AREA: props.firmsArea,
        FIRMS_SOURCES: "MODIS_NRT,VIIRS_SNPP_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT",
        FIRMS_DAYS_BACK: "2",
      },
    });
    secret.grantRead(this.handler);
    props.dataBucket.grantPut(this.handler, `${DATA_LAYOUT.rawFirmsPrefix}*`);

    // 06:00 UTC: after the night passes over South America are in the NRT feed.
    new events.Rule(this, "DailyRefresh", {
      description: "Pull the latest FIRMS NRT detections",
      schedule: events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(this.handler, { retryAttempts: 2 })],
    });
  }
}
