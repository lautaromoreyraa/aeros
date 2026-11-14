import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { DATA_LAYOUT } from "./data-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_LAMBDA_DIR = path.join(here, "..", "lambdas", "api");

export interface ApiStackProps extends StackProps {
  readonly dataBucket: s3.IBucket;
  readonly allowedOrigins: string[];
}

/**
 * HTTP API in front of one container Lambda. DuckDB reads the harmonized
 * Parquet straight from S3 with range requests, so a query over a small area
 * downloads a few row groups, not the whole table.
 */
export class ApiStack extends Stack {
  readonly api: apigw.HttpApi;
  readonly handler: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, "ApiHandlerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    this.handler = new lambda.DockerImageFunction(this, "ApiHandler", {
      description: "aeros calendar and hotspot CSV queries over the harmonized Parquet",
      code: lambda.DockerImageCode.fromImageAsset(API_LAMBDA_DIR, {
        platform: ecrAssets.Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      // DuckDB parallelizes the Parquet scan; memory buys vCPUs on Lambda.
      memorySize: 2048,
      // API Gateway gives up at 30 s; the function must answer before that.
      timeout: Duration.seconds(28),
      logGroup,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        CELLS_KEY: DATA_LAYOUT.cellsKey,
        HOTSPOTS_KEY: DATA_LAYOUT.hotspotsKey,
        MAX_CELLS: "20000",
        MAX_CSV_ROWS: "50000",
      },
    });
    props.dataBucket.grantRead(this.handler, `${DATA_LAYOUT.harmonizedPrefix}*`);

    // A stage of our own instead of the implicit one, to set throttling.
    this.api = new apigw.HttpApi(this, "HttpApi", {
      description: "aeros burning calendar API",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
        exposeHeaders: ["x-aeros-truncated", "content-disposition"],
        maxAge: Duration.hours(1),
      },
    });
    new apigw.HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    const integration = new HttpLambdaIntegration("ApiIntegration", this.handler);
    for (const routePath of ["/calendar", "/hotspots.csv"]) {
      this.api.addRoutes({ path: routePath, methods: [apigw.HttpMethod.POST], integration });
    }

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });
  }
}
