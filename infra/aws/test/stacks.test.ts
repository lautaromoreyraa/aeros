import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { type AerosStacks, buildAeros } from "../lib/aeros-app.js";
import { loadConfig } from "../lib/config.js";

const ENV = { account: "111111111111", region: "us-east-1" };

const CONTEXT = {
  "aeros:githubRepository": "lautaromoreyraa/aeros",
  "aeros:deployBranch": "main",
  "aeros:allowedOrigins": ["https://aeros.example.dev"],
  "aeros:firmsSecretName": "aeros/firms-map-key",
  "aeros:firmsArea": "-74,-56,-53,-21",
  "aeros:createGithubOidcProvider": true,
};

function build(extra: Record<string, unknown> = {}): AerosStacks {
  const app = new App({ context: { ...CONTEXT, ...extra } });
  return buildAeros(app, ENV);
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

let stacks: AerosStacks;
let data: Template;
let web: Template;
let api: Template;
let refresh: Template;
let deploy: Template;

beforeAll(() => {
  stacks = build();
  data = Template.fromStack(stacks.data);
  web = Template.fromStack(stacks.web);
  api = Template.fromStack(stacks.api);
  refresh = Template.fromStack(stacks.refresh);
  deploy = Template.fromStack(stacks.deploy);
});

describe("data bucket", () => {
  it("is private, encrypted, versioned and retained", () => {
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

describe("web", () => {
  it("serves the bucket through CloudFront with Origin Access Control only", () => {
    web.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    web.resourceCountIs("AWS::CloudFront::CloudFrontOriginAccessIdentity", 0);
    web.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
        Origins: [
          Match.objectLike({ OriginAccessControlId: Match.anyValue(), S3OriginConfig: Match.anyValue() }),
        ],
      }),
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

describe("api", () => {
  it("routes the two POST endpoints to one container Lambda", () => {
    api.hasResourceProperties("AWS::Lambda::Function", {
      PackageType: "Image",
      Architectures: ["arm64"],
      Timeout: 28,
      Environment: {
        Variables: Match.objectLike({
          CELLS_KEY: "harmonized/harmonized_cells.parquet",
          HOTSPOTS_KEY: "harmonized/hotspots_harmonized.parquet",
        }),
      },
    });
    const routes = Object.values(api.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => (r as any).Properties.RouteKey,
    );
    expect(routes.sort()).toEqual(["POST /calendar", "POST /hotspots.csv"]);
  });

  it("limits CORS to the configured origins and throttles the stage", () => {
    api.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://aeros.example.dev"] }),
    });
    api.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it("can only read the harmonized prefix of the data bucket", () => {
    const s3 = statements(api).filter((s) => actionsOf(s).some((a) => a.startsWith("s3:")));
    expect(s3.length).toBeGreaterThan(0);
    for (const statement of s3) {
      expect(actionsOf(statement).every((a) => /^s3:(Get|List)/.test(a))).toBe(true);
    }
    expect(JSON.stringify(s3)).toContain("/harmonized/*");
  });
});

describe("FIRMS refresh", () => {
  it("runs daily and knows the secret by name only", () => {
    refresh.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0 6 * * ? *)",
    });
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "python3.12",
      Handler: "refresh.handler",
      Environment: {
        Variables: Match.objectLike({
          FIRMS_SECRET_NAME: "aeros/firms-map-key",
          FIRMS_AREA: "-74,-56,-53,-21",
        }),
      },
    });
    // No secret is created here: the MAP_KEY is put in Secrets Manager by hand.
    refresh.resourceCountIs("AWS::SecretsManager::Secret", 0);
  });

  it("reads only that secret and writes only under raw/firms/", () => {
    const all = statements(refresh);
    const secret = all.filter((s) => actionsOf(s).includes("secretsmanager:GetSecretValue"));
    expect(JSON.stringify(secret)).toContain("secret:aeros/firms-map-key");
    const s3 = all.filter((s) => actionsOf(s).some((a) => a.startsWith("s3:")));
    for (const statement of s3) {
      expect(actionsOf(statement).some((a) => /^s3:(Get|Delete)/.test(a))).toBe(false);
    }
    expect(JSON.stringify(s3)).toContain("/raw/firms/*");
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
    const roles = deploy.findResources("AWS::IAM::Role");
    expect(JSON.stringify(roles)).not.toContain("AdministratorAccess");
  });

  it("reuses an existing OIDC provider when told to", () => {
    const reuse = Template.fromStack(build({ "aeros:createGithubOidcProvider": "false" }).deploy);
    reuse.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 0);
    expect(JSON.stringify(reuse.toJSON())).toContain(
      "oidc-provider/token.actions.githubusercontent.com",
    );
    deploy.resourceCountIs("Custom::AWSCDKOpenIdConnectProvider", 1);
  });
});

describe("config", () => {
  it("rejects a repository that is not owner/name", () => {
    const app = new App({ context: { ...CONTEXT, "aeros:githubRepository": "aeros" } });
    expect(() => loadConfig(app)).toThrow(/owner\/name/);
  });

  it("rejects a malformed FIRMS area", () => {
    const app = new App({ context: { ...CONTEXT, "aeros:firmsArea": "-74,-56" } });
    expect(() => loadConfig(app)).toThrow(/firmsArea/);
  });
});
