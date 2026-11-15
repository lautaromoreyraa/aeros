import { App, type Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { type AerosStacks, buildAeros } from "../lib/aeros-app.js";
import { loadConfig } from "../lib/config.js";

const ACCOUNT = "111111111111";
// Not us-east-1 on purpose: nothing may assume the Region.
const REGION = "sa-east-1";

const CONTEXT = {
  region: REGION,
  "aeros:githubRepository": "lautaromoreyraa/aeros",
  "aeros:deployBranch": "main",
  "aeros:firmsMapKeyParameter": "/aeros/firms/map-key",
  "aeros:firmsArea": "-69,-35,-53,-16",
  "aeros:createGithubOidcProvider": true,
  "aeros:webUrl": "https://aeros.example.org",
  "aeros:alertRegionName": "Test region",
  // Synthesize without building the Python layer (pip, network).
  "aws:cdk:bundling-stacks": [],
};

function build(extra: Record<string, unknown> = {}): AerosStacks {
  const app = new App({ context: { ...CONTEXT, ...extra } });
  return buildAeros(app, ACCOUNT);
}

/** Every IAM statement of a template, flattened. */
function statements(template: Template): Array<Record<string, unknown>> {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => (policy as any).Properties.PolicyDocument.Statement,
  );
}

function actionsOf(statement: Record<string, unknown>): string[] {
  const action = statement.Action as string | string[];
  return Array.isArray(action) ? action : [action];
}

function resources(template: Template): Array<[string, { Type: string; Properties?: any }]> {
  return Object.entries(template.toJSON().Resources ?? {}) as any;
}

let stacks: AerosStacks;
let all: Array<[Stack, Template]>;
let data: Template;
let web: Template;
let refresh: Template;
let budget: Template;
let deploy: Template;

beforeAll(() => {
  stacks = build();
  all = Object.values(stacks).map((s: Stack) => [s, Template.fromStack(s)]);
  data = Template.fromStack(stacks.data);
  web = Template.fromStack(stacks.web);
  refresh = Template.fromStack(stacks.refresh);
  budget = Template.fromStack(stacks.budget);
  deploy = Template.fromStack(stacks.deploy);
});

describe("AWS Free plan", () => {
  const FORBIDDEN = [
    /^AWS::ApiGateway::/,
    /^AWS::ApiGatewayV2::/,
    /^AWS::SecretsManager::Secret$/,
    /^AWS::Route53::HostedZone$/,
    /^AWS::EC2::NatGateway$/,
    /^AWS::EC2::Instance$/,
    /^AWS::KMS::Key$/,
    /^AWS::ElasticLoadBalancingV2::/,
    /^AWS::ECR::/,
  ];

  it("uses none of the forbidden resource types", () => {
    const found = all.flatMap(([stack, template]) =>
      resources(template)
        .filter(([, r]) => FORBIDDEN.some((re) => re.test(r.Type)))
        .map(([id, r]) => `${stack.stackName}/${id}: ${r.Type}`),
    );
    expect(found).toEqual([]);
  });

  it("runs every function as a small zip, outside any VPC", () => {
    let count = 0;
    for (const [, template] of all) {
      for (const [id, r] of resources(template)) {
        if (r.Type !== "AWS::Lambda::Function") continue;
        count += 1;
        expect(r.Properties.PackageType, id).not.toBe("Image");
        expect(r.Properties.VpcConfig, id).toBeUndefined();
        expect(r.Properties.MemorySize ?? 128, id).toBeLessThanOrEqual(512);
      }
    }
    // API, alert subscriptions, daily refresh, GOES watch and Telegram webhook:
    // no custom-resource functions.
    expect(count).toBe(5);
  });

  it("reserves no concurrency by default, because a new account cannot", () => {
    // Lambda always keeps 100 executions unreserved and a new account's quota
    // starts at 10: any reservation makes the deploy fail there.
    for (const [, template] of all) {
      for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
        expect((fn as any).Properties.ReservedConcurrentExecutions).toBeUndefined();
      }
    }
  });

  it("can reserve low concurrency once the account's quota allows it", () => {
    const raised = build({
      "aeros:apiReservedConcurrency": "2",
      "aeros:refreshReservedConcurrency": "1",
    });
    Template.fromStack(raised.web).hasResourceProperties("AWS::Lambda::Function", {
      Handler: "aeros_api.handler.handler",
      ReservedConcurrentExecutions: 2,
    });
    Template.fromStack(raised.refresh).hasResourceProperties("AWS::Lambda::Function", {
      Handler: "refresh.handler",
      ReservedConcurrentExecutions: 1,
    });
  });

  it("keeps every log group for 7 days", () => {
    let count = 0;
    for (const [, template] of all) {
      for (const [id, r] of resources(template)) {
        if (r.Type !== "AWS::Logs::LogGroup") continue;
        count += 1;
        expect(r.Properties.RetentionInDays, id).toBe(7);
      }
    }
    expect(count).toBe(5);
  });

  it("puts every stack in the context Region and never names us-east-1", () => {
    for (const [stack, template] of all) {
      expect(stack.region).toBe(REGION);
      expect(JSON.stringify(template.toJSON())).not.toContain("us-east-1");
    }
  });

  it("has no Lambda@Edge association", () => {
    const json = JSON.stringify(web.toJSON());
    expect(json).not.toContain("LambdaFunctionAssociations");
  });

  it("requires the region in context", () => {
    const app = new App({ context: { ...CONTEXT, region: undefined } });
    expect(() => loadConfig(app)).toThrow(/region/);
  });
});

describe("data bucket", () => {
  it("is private, SSE-S3 encrypted, versioned and retained", () => {
    data.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: "Enabled" },
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        }),
      },
    });
  });

  it("expires raw downloads and old versions", () => {
    data.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 7 } }),
          Match.objectLike({ Prefix: "raw/firms/", ExpirationInDays: 90, Status: "Enabled" }),
        ]),
      },
    });
  });

  it("refuses plain HTTP", () => {
    data.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });
});

describe("web and API", () => {
  it("serves the bucket through CloudFront with Origin Access Control only", () => {
    web.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    web.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({ OriginAccessControlOriginType: "s3" }),
    });
    web.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Condition: { StringEquals: { "AWS:SourceArn": Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it("exposes the API only as an IAM function URL signed by CloudFront", () => {
    web.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
    web.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
      }),
    });
    const permissions = Object.values(web.findResources("AWS::Lambda::Permission")).map(
      (p) => (p as any).Properties,
    );
    // Two IAM function URLs (API and alerts), each with both permissions.
    expect(permissions.map((p) => p.Action).sort()).toEqual([
      "lambda:InvokeFunction",
      "lambda:InvokeFunction",
      "lambda:InvokeFunctionUrl",
      "lambda:InvokeFunctionUrl",
    ]);
    for (const p of permissions) {
      expect(p.Principal).toBe("cloudfront.amazonaws.com");
      expect(JSON.stringify(p.SourceArn)).toContain(":distribution/");
    }
  });

  it("routes /api/* uncached with viewer headers, and caches the early warning", () => {
    const config = (web.findResources("AWS::CloudFront::Distribution") as any);
    const [distribution] = Object.values(config) as any[];
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors;
    expect(behaviors.map((b: any) => b.PathPattern)).toEqual([
      "/api/early-warning",
      "/api/active-fires",
      "/api/alerts/*",
      "/api/*",
    ]);
    const api = behaviors[3];
    expect(api.AllowedMethods).toContain("POST");
    expect(api.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // CachingDisabled
    expect(api.OriginRequestPolicyId).toBe("b689b0a8-53d0-40ab-baf2-68738e2966ac"); // AllViewerExceptHostHeader
    expect(behaviors[0].AllowedMethods).toEqual(["GET", "HEAD"]);
    expect(behaviors[1].AllowedMethods).toEqual(["GET", "HEAD"]);
  });

  it("rewrites client-side routes with a CloudFront Function, not error pages", () => {
    web.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }),
    });
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [Match.objectLike({ EventType: "viewer-request" })],
        }),
      }),
    });
  });

  it("attaches the security headers", () => {
    web.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true }),
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
          }),
        }),
      }),
    });
  });

  it("runs the API from the zip and the shared layer", () => {
    web.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "python3.12",
      Handler: "aeros_api.handler.handler",
      Architectures: ["arm64"],
      MemorySize: 512,
      Layers: [Match.anyValue()],
      Environment: {
        Variables: Match.objectLike({
          CELLS_KEY: "harmonized/harmonized_cells.parquet",
          HOTSPOTS_KEY: "harmonized/hotspots_harmonized.parquet",
          EARLY_WARNING_KEY: "derived/early_warning.json",
        }),
      },
    });
    web.hasResourceProperties("AWS::Lambda::LayerVersion", {
      CompatibleRuntimes: ["python3.12"],
      CompatibleArchitectures: ["arm64"],
    });
  });

  it("lets the API only read the harmonized tables and the early warning", () => {
    const s3 = statements(web).filter((s) => actionsOf(s).some((a) => a.startsWith("s3:")));
    expect(s3.length).toBeGreaterThan(0);
    for (const statement of s3) {
      expect(actionsOf(statement).every((a) => /^s3:(Get|List)/.test(a))).toBe(true);
    }
    const json = JSON.stringify(s3);
    expect(json).toContain("/harmonized/*");
    expect(json).toContain("/derived/early_warning.json");
  });

  it("uses the custom domain only when both domain and certificate are given", () => {
    const withDomain = Template.fromStack(
      build({
        "aeros:webDomainName": "aeros.example.dev",
        "aeros:webCertificateArn": "arn:aws:acm:us-east-1:111111111111:certificate/abc",
      }).web,
    );
    withDomain.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ Aliases: ["aeros.example.dev"] }),
    });
    expect(() => build({ "aeros:webDomainName": "aeros.example.dev" })).toThrow(/go together/);
  });
});

describe("FIRMS refresh and early warning", () => {
  it("runs daily on NOAA-20/21 and MODIS, never Suomi NPP", () => {
    refresh.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
    });
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "python3.12",
      Handler: "refresh.handler",
      MemorySize: 512,
      Environment: {
        Variables: Match.objectLike({
          FIRMS_MAP_KEY_PARAMETER: "/aeros/firms/map-key",
          FIRMS_AREA: "-69,-35,-53,-16",
          FIRMS_SOURCES: "MODIS_NRT,VIIRS_NOAA20_NRT,VIIRS_NOAA21_NRT",
          FIRMS_DAYS_BACK: "7",
          EARLY_WARNING_KEY: "derived/early_warning.json",
        }),
      },
    });
  });

  it("reads the MAP_KEY from Parameter Store by name and creates no secret", () => {
    refresh.resourceCountIs("AWS::SSM::Parameter", 0);
    const ssm = statements(refresh).filter((s) => actionsOf(s).includes("ssm:GetParameter"));
    expect(JSON.stringify(ssm)).toContain(":parameter/aeros/firms/map-key");
    expect(JSON.stringify(statements(refresh))).not.toContain("secretsmanager:");
  });

  it("writes only raw/firms/, the published reports and the alert states; reads harmonized/ and the states", () => {
    const s3 = statements(refresh).filter((s) => actionsOf(s).some((a) => a.startsWith("s3:")));
    for (const statement of s3) {
      expect(actionsOf(statement).some((a) => /^s3:Delete/.test(a))).toBe(false);
      const json = JSON.stringify(statement.Resource);
      const writes = actionsOf(statement).some((a) => /^s3:(Put|Abort)/.test(a));
      if (writes) {
        expect(json).toMatch(
          /raw\/firms\/\*|derived\/early_warning\.json|derived\/goes_latest\.json|state\/(goes_)?alerts\.json/,
        );
      } else {
        expect(json).toMatch(
          /\/harmonized\/\*|\/harmonized\/harmonized_cells\.parquet|\/state\/(goes_)?alerts\.json|\/derived\/(wind|fire_weather)\.json/,
        );
      }
    }
  });

  it("reads exactly the five alert parameters with GetParameter only", () => {
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          ALERT_STATE_KEY: "state/alerts.json",
          ALERT_WEB_URL: "https://aeros.example.org",
          ALERT_EMAIL_FROM_PARAMETER: "/aeros/alerts/email-from",
          ALERT_EMAIL_TO_PARAMETER: "/aeros/alerts/email-to",
          ALERT_TELEGRAM_TOKEN_PARAMETER: "/aeros/alerts/telegram-token",
          ALERT_TELEGRAM_CHAT_PARAMETER: "/aeros/alerts/telegram-chat-id",
          ALERT_RESEND_KEY_PARAMETER: "/aeros/alerts/resend-api-key",
        }),
      },
    });
    // The daily refresh and the GOES watch read the five; the webhook reads its own two.
    const alertReads = statements(refresh).filter((s) =>
      JSON.stringify(s.Resource).includes("parameter/aeros/alerts/email-to"),
    );
    expect(alertReads).toHaveLength(2);
    for (const read of alertReads) {
      expect(actionsOf(read)).toEqual(["ssm:GetParameter"]);
      const json = JSON.stringify(read.Resource);
      for (const name of [
        "email-from",
        "email-to",
        "telegram-token",
        "telegram-chat-id",
        "resend-api-key",
      ]) {
        expect(json).toContain(`:parameter/aeros/alerts/${name}`);
      }
      expect(json).not.toContain("*");
    }
  });

  it("grants no SES permission unless a sender identity is given", () => {
    expect(JSON.stringify(statements(refresh))).not.toContain("ses:");
  });

  it("scopes ses:SendEmail to the sender identity alone", () => {
    const template = Template.fromStack(
      build({ "aeros:alertEmailIdentity": "alerts.example.org" }).refresh,
    );
    const ses = statements(template).filter((s) => actionsOf(s).some((a) => a.startsWith("ses:")));
    expect(ses).toHaveLength(2);
    for (const send of ses) {
      expect(actionsOf(send)).toEqual(["ses:SendEmail"]);
      const json = JSON.stringify(send.Resource);
      expect(json).toContain(":identity/alerts.example.org");
      expect(json).not.toContain("*");
    }
  });

  it("watches GOES-19 every 10 minutes without retries and never reads the MAP_KEY", () => {
    refresh.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(10 minutes)",
      Targets: Match.arrayWith([
        Match.objectLike({ RetryPolicy: Match.objectLike({ MaximumRetryAttempts: 0 }) }),
      ]),
    });
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "goes_watch.handler",
      MemorySize: 512,
      Environment: {
        Variables: Match.objectLike({
          GOES_LATEST_KEY: "derived/goes_latest.json",
          GOES_ALERT_STATE_KEY: "state/goes_alerts.json",
          FIRMS_AREA: "-69,-35,-53,-16",
          FIRMS_MAP_KEY_PARAMETER: Match.absent(),
        }),
      },
    });
  });
});

describe("budget", () => {
  it("alerts on USD 1 of actual monthly cost through SNS", () => {
    budget.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 1, Unit: "USD" },
      }),
      NotificationsWithSubscribers: [
        {
          Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 100 }),
          Subscribers: [Match.objectLike({ SubscriptionType: "SNS" })],
        },
      ],
    });
    budget.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: "budgets.amazonaws.com" } }),
        ]),
      },
    });
    budget.hasOutput("FreePlanLimits", { Value: Match.stringLikeRegexp("Free plan") });
  });

  it("subscribes an e-mail only when one is passed at deploy time", () => {
    budget.resourceCountIs("AWS::SNS::Subscription", 0);
    const withEmail = Template.fromStack(build({ "aeros:budgetEmail": "ops@example.dev" }).budget);
    withEmail.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email" });
  });
});

describe("GitHub deploy role", () => {
  it("trusts only this repository's deploy branch or production environment", () => {
    deploy.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
              StringLike: {
                "token.actions.githubusercontent.com:sub": [
                  "repo:lautaromoreyraa/aeros:ref:refs/heads/main",
                  "repo:lautaromoreyraa/aeros:environment:production",
                ],
              },
            },
          }),
        ],
      },
    });
  });

  it("has no wildcard actions and no admin policy", () => {
    for (const statement of statements(deploy)) {
      for (const action of actionsOf(statement)) {
        expect(action).not.toBe("*");
        expect(action.endsWith(":*")).toBe(false);
      }
    }
    expect(JSON.stringify(deploy.findResources("AWS::IAM::Role"))).not.toContain(
      "AdministratorAccess",
    );
  });

  it("creates a native OIDC provider, or reuses the account's", () => {
    deploy.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    const reuse = Template.fromStack(build({ "aeros:createGithubOidcProvider": "false" }).deploy);
    reuse.resourceCountIs("AWS::IAM::OIDCProvider", 0);
    expect(JSON.stringify(reuse.toJSON())).toContain(
      "oidc-provider/token.actions.githubusercontent.com",
    );
  });
});

describe("config", () => {
  it("rejects a web URL that is not https", () => {
    expect(() => build({ "aeros:webUrl": "http://aeros.example.org" })).toThrow(/aeros:webUrl/);
  });

  it("rejects a malformed SES identity", () => {
    expect(() => build({ "aeros:alertEmailIdentity": "not an identity" })).toThrow(
      /alertEmailIdentity/,
    );
  });

  it("rejects a repository that is not owner/name", () => {
    const app = new App({ context: { ...CONTEXT, "aeros:githubRepository": "aeros" } });
    expect(() => loadConfig(app)).toThrow(/owner\/name/);
  });

  it("rejects a malformed FIRMS area", () => {
    const app = new App({ context: { ...CONTEXT, "aeros:firmsArea": "-74,-56" } });
    expect(() => loadConfig(app)).toThrow(/firmsArea/);
  });

  it("rejects a parameter name that is not a path", () => {
    const app = new App({ context: { ...CONTEXT, "aeros:firmsMapKeyParameter": "map-key" } });
    expect(() => loadConfig(app)).toThrow(/firmsMapKeyParameter/);
  });
});
