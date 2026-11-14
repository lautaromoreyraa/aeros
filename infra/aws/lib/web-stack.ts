import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

export interface WebStackProps extends StackProps {
  /** Custom domain (Cloudflare points it at CloudFront). */
  readonly domainName?: string;
  /** ACM certificate in us-east-1 covering domainName. */
  readonly certificateArn?: string;
}

/**
 * Static web app: a private bucket that only CloudFront can read (Origin
 * Access Control), and a distribution that adds the security headers.
 */
export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps = {}) {
    super(scope, id, props);

    // The bucket only holds build output that CI uploads again on every
    // deploy, so it can go away with the stack.
    this.bucket = new s3.Bucket(this, "WebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "aeros web security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          // connect-src and img-src stay open to https: because the map pulls
          // tiles and the app calls the API on another origin; scripts do not.
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

    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Certificate", props.certificateArn)
      : undefined;

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "aeros web",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Only settable with a custom certificate; the *.cloudfront.net one is fixed.
      minimumProtocolVersion: certificate
        ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
        : undefined,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // Without ListBucket a missing key is a 403. Client-side routes are
      // missing keys too, so both statuses hand back the app shell.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: "/index.html",
        ttl: Duration.seconds(10),
      })),
    });
  }
}
