import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { DATA_LAYOUT } from "./data-stack.js";
import { PythonDepsLayer } from "./python-deps-layer.js";
import {
  ALERT_PARAMETERS,
  REFRESH_CODE_EXCLUDE,
  REFRESH_LAMBDA_DIR,
  SUBSCRIPTION_PARAMETERS,
  grantParameters,
  grantFireCheck,
  grantSubscriptionsTable,
} from "./refresh-stack.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_LAMBDA_DIR = path.join(here, "..", "lambdas", "api");

export interface WebStackProps extends StackProps {
  readonly dataBucket: s3.IBucket;
  /** Concurrency reserved for the API function; 0 leaves it unreserved. */
  readonly apiReservedConcurrency: number;
  /** Where alert subscriptions are stored. */
  readonly subscriptionsTable: dynamodb.ITable;
  /** FIRMS area as "west,south,east,north": cells outside it cannot be subscribed. */
  readonly firmsArea: string;
  /** Public URL of the web app; the e-mail links point at it. */
  readonly webUrl: string;
  /** Verified SES identity the confirmation e-mails come from; none, no e-mail. */
  readonly alertEmailIdentity?: string;
  /** Custom domain (Cloudflare points it at CloudFront). */
  readonly domainName?: string;
  /** ACM certificate in us-east-1 covering domainName (a CloudFront requirement). */
  readonly certificateArn?: string;
}

// Client-side routes have no file extension: hand them the app shell. A
// CloudFront Function (not Lambda@Edge, which the free plan excludes) does it
// on the static behavior only, so API 404s are never rewritten into HTML the
// way distribution-wide error responses would.
const SPA_REWRITE = `
function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`;

/**
 * Everything the browser talks to, on one CloudFront distribution:
 *
 * - `/*`     the static app, from a private bucket through Origin Access Control;
 * - `/api/*` the API Lambda through its function URL, also behind OAC, so the
 *   URL (auth type AWS_IAM) rejects anything CloudFront did not sign;
 * - `/api/alerts/*` the alert subscriptions Lambda, the same way.
 *
 * Function URLs and CloudFront replace API Gateway: both fall under the
 * always-free allowances, and one origin for app and API removes CORS.
 */
export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly apiHandler: lambda.Function;
  readonly alertsHandler: lambda.Function;
  private layer!: PythonDepsLayer;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // Retained like the data bucket: an auto-delete custom resource would add
    // a Lambda of its own just to empty a bucket CI refills on every deploy.
    this.bucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.layer = new PythonDepsLayer(this, "PythonDeps");
    this.apiHandler = this.apiFunction(props);
    const apiUrl = this.apiHandler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl, {
      readTimeout: Duration.seconds(30),
    });

    this.alertsHandler = this.alertsFunction(props);
    const alertsUrl = this.alertsHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    const alertsOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(alertsUrl, {
      readTimeout: Duration.seconds(30),
    });

    const headers = this.securityHeaders();
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "aeros web and API",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // The cheaper classes leave out South America, where the audience is;
      // the always-free transfer allowance covers every edge location.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      // Only settable with a custom certificate; the *.cloudfront.net one is fixed.
      minimumProtocolVersion: certificate
        ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
        : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, "SpaRewrite", {
              comment: "Serve index.html for client-side routes",
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
            }),
          },
        ],
      },
      additionalBehaviors: {
        // The early warning changes once a day: let the edge answer it.
        "/api/early-warning": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: new cloudfront.CachePolicy(this, "EarlyWarningCache", {
            comment: "aeros early warning, refreshed daily",
            defaultTtl: Duration.minutes(15),
            minTtl: Duration.seconds(0),
            maxTtl: Duration.hours(1),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
          }),
          responseHeadersPolicy: headers,
          compress: true,
        },
        // The GOES layer changes every 10 minutes: a two-minute edge cache
        // keeps a burst of visitors from turning into a burst of invocations.
        "/api/active-fires": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: new cloudfront.CachePolicy(this, "ActiveFiresCache", {
            comment: "aeros GOES-19 active fires, refreshed every 10 minutes",
            defaultTtl: Duration.minutes(2),
            minTtl: Duration.seconds(0),
            maxTtl: Duration.minutes(5),
            enableAcceptEncodingGzip: true,
            enableAcceptEncodingBrotli: true,
          }),
          responseHeadersPolicy: headers,
          compress: true,
        },
        // Sign-ups, confirmations and unsubscribes: never cached, and the query
        // string (the e-mail token) and viewer headers reach the function. Listed
        // before /api/* because CloudFront takes the first pattern that matches.
        "/api/alerts/*": {
          origin: alertsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        // Queries depend on the body, so nothing is cached. Viewer headers go
        // through: POSTs carry x-amz-content-sha256, which CloudFront needs to
        // sign the request for Lambda.
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
          compress: true,
        },
      },
    });

    new CfnOutput(this, "WebUrl", { value: `https://${this.distribution.domainName}` });
    new CfnOutput(this, "WebBucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
  }

  private apiFunction(props: WebStackProps): lambda.Function {
    const logGroup = new logs.LogGroup(this, "ApiHandlerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, "ApiHandler", {
      description: "aeros calendar, hotspot CSV and early warning",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "aeros_api.handler.handler",
      // Allow-list: only the package reaches the function, never tests or caches.
      code: lambda.Code.fromAsset(API_LAMBDA_DIR, {
        exclude: ["*", ".*", "!aeros_api", "!aeros_api/*.py"],
      }),
      layers: [this.layer],
      // 512 MB keeps a busy month inside the always-free GB-seconds; DuckDB
      // gets 60 % of it and spills to /tmp beyond that.
      memorySize: 512,
      // CloudFront waits 30 s for the origin; answer, or fail, before that.
      timeout: Duration.seconds(25),
      reservedConcurrentExecutions: props.apiReservedConcurrency || undefined,
      logGroup,
      environment: {
        DATA_BUCKET: props.dataBucket.bucketName,
        CELLS_KEY: DATA_LAYOUT.cellsKey,
        HOTSPOTS_KEY: DATA_LAYOUT.hotspotsKey,
        EARLY_WARNING_KEY: DATA_LAYOUT.earlyWarningKey,
        GOES_LATEST_KEY: DATA_LAYOUT.goesLatestKey,
        DUCKDB_HTTPFS: "/opt/duckdb/httpfs.duckdb_extension",
        MAX_CELLS: "20000",
        MAX_CSV_ROWS: "50000",
      },
    });
    props.dataBucket.grantRead(fn, `${DATA_LAYOUT.harmonizedPrefix}*`);
    props.dataBucket.grantRead(fn, DATA_LAYOUT.earlyWarningKey);
    props.dataBucket.grantRead(fn, DATA_LAYOUT.goesLatestKey);
    return fn;
  }

  /**
   * Alert subscriptions API. It reuses the refresh code directory (the rules
   * live next to the notifier that uses them) and the same layer, and gets
   * only what it does: the table, the sender and bot-name parameters, and
   * sending from the one SES identity.
   */
  private alertsFunction(props: WebStackProps): lambda.Function {
    const logGroup = new logs.LogGroup(this, "AlertsHandlerLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, "AlertsHandler", {
      description: "aeros alert subscriptions and fire reports",
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: "alerts_api.handler",
      code: lambda.Code.fromAsset(REFRESH_LAMBDA_DIR, { exclude: REFRESH_CODE_EXCLUDE }),
      layers: [this.layer],
      memorySize: 256,
      timeout: Duration.seconds(25),
      logGroup,
      environment: {
        SUBSCRIPTIONS_TABLE: props.subscriptionsTable.tableName,
        FIRMS_AREA: props.firmsArea,
        ALERT_WEB_URL: props.webUrl,
        ALERT_EMAIL_FROM_PARAMETER: ALERT_PARAMETERS.emailFrom,
        ALERT_RESEND_KEY_PARAMETER: ALERT_PARAMETERS.resendKey,
        ALERT_TELEGRAM_BOT_PARAMETER: SUBSCRIPTION_PARAMETERS.telegramBot,
        TWILIO_ACCOUNT_SID_PARAMETER: ALERT_PARAMETERS.twilioAccountSid,
        TWILIO_AUTH_TOKEN_PARAMETER: ALERT_PARAMETERS.twilioAuthToken,
        TWILIO_FROM_PARAMETER: ALERT_PARAMETERS.twilioFrom,
        HTTPSMS_API_KEY_PARAMETER: ALERT_PARAMETERS.httpsmsApiKey,
        HTTPSMS_FROM_PARAMETER: ALERT_PARAMETERS.httpsmsFrom,
        // GET /api/alerts/fire-check reads what the satellites saw around a reported point.
        DATA_BUCKET: props.dataBucket.bucketName,
        GOES_LATEST_KEY: DATA_LAYOUT.goesLatestKey,
        RAW_PREFIX: DATA_LAYOUT.rawFirmsPrefix,
      },
    });
    grantSubscriptionsTable(fn, props.subscriptionsTable);
    grantFireCheck(fn, props.dataBucket);
    grantParameters(this, fn, [
      ALERT_PARAMETERS.emailFrom,
      ALERT_PARAMETERS.resendKey,
      ALERT_PARAMETERS.twilioAccountSid,
      ALERT_PARAMETERS.twilioAuthToken,
      ALERT_PARAMETERS.twilioFrom,
      ALERT_PARAMETERS.httpsmsApiKey,
      ALERT_PARAMETERS.httpsmsFrom,
      SUBSCRIPTION_PARAMETERS.telegramBot,
    ]);
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
    return fn;
  }

  private securityHeaders(): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "aeros web security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          // img-src and connect-src stay open to https: for map tiles; the
          // API is same-origin now, scripts never leave 'self'.
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'wasm-unsafe-eval'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "connect-src 'self' https:",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            "upgrade-insecure-requests",
          ].join("; "),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
            override: true,
          },
          { header: "Cross-Origin-Opener-Policy", value: "same-origin", override: true },
        ],
      },
    });
  }
}
