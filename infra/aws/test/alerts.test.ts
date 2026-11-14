import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { type AerosStacks, buildAeros } from "../lib/aeros-app.js";
import { REFRESH_CODE_EXCLUDE, REFRESH_LAMBDA_DIR } from "../lib/refresh-stack.js";

const CONTEXT = {
  region: "sa-east-1",
  "aeros:githubRepository": "lautaromoreyraa/aeros",
  "aeros:deployBranch": "main",
  "aeros:firmsMapKeyParameter": "/aeros/firms/map-key",
  "aeros:firmsArea": "-69,-35,-53,-16",
  "aeros:createGithubOidcProvider": true,
  "aeros:webUrl": "https://aeros.example.org",
  "aeros:alertRegionName": "Test region",
  "aws:cdk:bundling-stacks": [],
};

function build(extra: Record<string, unknown> = {}): AerosStacks {
  return buildAeros(new App({ context: { ...CONTEXT, ...extra } }), "111111111111");
}

function statements(template: Template): Array<Record<string, any>> {
  return Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
    (policy) => (policy as any).Properties.PolicyDocument.Statement,
  );
}

function actionsOf(statement: Record<string, any>): string[] {
  const action = statement.Action as string | string[];
  return Array.isArray(action) ? action : [action];
}

/** The statements of the function with this handler, found through its role. */
function statementsOfHandler(template: Template, handler: string): Array<Record<string, any>> {
  const functions = template.findResources("AWS::Lambda::Function", {
    Properties: { Handler: handler },
  });
  const [fn] = Object.values(functions) as any[];
  const role = fn.Properties.Role["Fn::GetAtt"][0] as string;
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

let stacks: AerosStacks;
let data: Template;
let web: Template;
let refresh: Template;

beforeAll(() => {
  stacks = build();
  data = Template.fromStack(stacks.data);
  web = Template.fromStack(stacks.web);
  refresh = Template.fromStack(stacks.refresh);
});

describe("subscriptions table", () => {
  it("is provisioned well inside the always-free 25 read and 25 write units", () => {
    data.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: Match.absent(), // absent means PROVISIONED
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
    data.resourceCountIs("AWS::DynamoDB::Table", 1);
  });

  it("is retained and has no billed extras", () => {
    data.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Retain" });
    const table = Object.values(data.findResources("AWS::DynamoDB::Table"))[0] as any;
    expect(table.Properties.PointInTimeRecoverySpecification).toBeUndefined();
    expect(table.Properties.StreamSpecification).toBeUndefined();
    expect(table.Properties.GlobalSecondaryIndexes).toBeUndefined();
    expect(table.Properties.SSESpecification).toBeUndefined(); // the free AWS-owned key
    data.resourceCountIs("AWS::ApplicationAutoScaling::ScalableTarget", 0);
  });

  it("is touched by its three users with four actions and nothing else", () => {
    const users: Array<[Template, string]> = [
      [web, "alerts_api.handler"],
      [refresh, "alerts_api.webhook"],
      [refresh, "refresh.handler"],
    ];
    for (const [template, handler] of users) {
      const found = statementsOfHandler(template, handler).filter((s) =>
        actionsOf(s).some((a) => a.startsWith("dynamodb:")),
      );
      expect(found, handler).toHaveLength(1);
      expect(actionsOf(found[0]!).sort()).toEqual([
        "dynamodb:DeleteItem",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Scan",
      ]);
      expect(JSON.stringify(found[0]!.Resource)).not.toContain("*");
    }
  });
});

describe("alert subscriptions API", () => {
  it("is an IAM function URL behind CloudFront, never public", () => {
    web.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "alerts_api.handler",
      MemorySize: 256,
      Environment: {
        Variables: Match.objectLike({
          FIRMS_AREA: "-69,-35,-53,-16",
          ALERT_WEB_URL: "https://aeros.example.org",
          ALERT_EMAIL_FROM_PARAMETER: "/aeros/alerts/email-from",
          ALERT_TELEGRAM_BOT_PARAMETER: "/aeros/alerts/telegram-bot",
        }),
      },
    });
    const urls = Object.values(web.findResources("AWS::Lambda::Url")) as any[];
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.Properties.AuthType === "AWS_IAM")).toBe(true);
  });

  it("reads only the sender and bot-name parameters", () => {
    const reads = statementsOfHandler(web, "alerts_api.handler").filter((s) =>
      actionsOf(s).includes("ssm:GetParameter"),
    );
    expect(reads).toHaveLength(1);
    const json = JSON.stringify(reads[0]!.Resource);
    expect(json).toContain(":parameter/aeros/alerts/email-from");
    expect(json).toContain(":parameter/aeros/alerts/telegram-bot");
    expect(json).not.toContain("telegram-token");
    expect(json).not.toContain("*");
  });

  it("sends e-mail only from the sender identity, and not at all without one", () => {
    const none = statementsOfHandler(web, "alerts_api.handler");
    expect(JSON.stringify(none)).not.toContain("ses:");
    const withIdentity = Template.fromStack(
      build({ "aeros:alertEmailIdentity": "alerts.example.org" }).web,
    );
    const ses = statementsOfHandler(withIdentity, "alerts_api.handler").filter((s) =>
      actionsOf(s).some((a) => a.startsWith("ses:")),
    );
    expect(ses).toHaveLength(1);
    expect(actionsOf(ses[0]!)).toEqual(["ses:SendEmail"]);
    expect(JSON.stringify(ses[0]!.Resource)).toContain(":identity/alerts.example.org");
  });

  it("can never touch the data bucket", () => {
    expect(JSON.stringify(statementsOfHandler(web, "alerts_api.handler"))).not.toContain("s3:");
  });
});

describe("Telegram webhook", () => {
  it("is the one public function URL, and says why", () => {
    const urls = Object.values(refresh.findResources("AWS::Lambda::Url")) as any[];
    expect(urls).toHaveLength(1);
    expect(urls[0].Properties.AuthType).toBe("NONE");
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "alerts_api.webhook",
      MemorySize: 256,
      Timeout: 15,
    });
    refresh.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunctionUrl",
      FunctionUrlAuthType: "NONE",
      Principal: "*",
    });
    refresh.hasResourceProperties("AWS::Lambda::Permission", {
      Action: "lambda:InvokeFunction",
      InvokedViaFunctionUrl: true,
      Principal: "*",
    });
    refresh.hasOutput("TelegramWebhookUrl", {});
  });

  it("reads the bot token and the webhook secret, and nothing else", () => {
    const reads = statementsOfHandler(refresh, "alerts_api.webhook").filter((s) =>
      actionsOf(s).includes("ssm:GetParameter"),
    );
    expect(reads).toHaveLength(1);
    const json = JSON.stringify(reads[0]!.Resource);
    expect(json).toContain(":parameter/aeros/alerts/telegram-token");
    expect(json).toContain(":parameter/aeros/alerts/telegram-webhook-secret");
    expect(json).not.toContain("email");
    expect(json).not.toContain("*");
    const all = JSON.stringify(statementsOfHandler(refresh, "alerts_api.webhook"));
    expect(all).not.toContain("ses:");
    expect(all).not.toContain("s3:");
  });

  it("creates no secret: the parameters are made by hand", () => {
    refresh.resourceCountIs("AWS::SSM::Parameter", 0);
    web.resourceCountIs("AWS::SSM::Parameter", 0);
  });
});

describe("the daily refresh notifies subscribers", () => {
  it("knows the table and the optional wind and fire-weather files", () => {
    refresh.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "refresh.handler",
      Environment: {
        Variables: Match.objectLike({
          SUBSCRIPTIONS_TABLE: Match.anyValue(),
          WIND_KEY: "derived/wind.json",
          FIRE_WEATHER_KEY: "derived/fire_weather.json",
        }),
      },
    });
  });
});

describe("shipped code", () => {
  const exclude = new Set(REFRESH_CODE_EXCLUDE.filter((p) => p.startsWith("!")).map((p) => p.slice(1)));
  const modules = readdirSync(REFRESH_LAMBDA_DIR)
    .filter((f) => f.endsWith(".py"))
    .map((f) => f.slice(0, -3));

  /** Local modules a Python file imports, at the top level. */
  function importsOf(module: string): string[] {
    const source = readFileSync(path.join(REFRESH_LAMBDA_DIR, `${module}.py`), "utf8");
    const found = new Set<string>();
    for (const m of source.matchAll(/^(?:import|from)\s+([A-Za-z_][\w]*)/gm)) {
      if (modules.includes(m[1]!)) found.add(m[1]!);
    }
    return [...found];
  }

  it("includes every module the handlers import, directly or not", () => {
    const needed = new Set<string>();
    const walk = (module: string) => {
      if (needed.has(module)) return;
      needed.add(module);
      importsOf(module).forEach(walk);
    };
    ["refresh", "goes_watch", "alerts_api"].forEach(walk);
    const missing = [...needed].filter((m) => !exclude.has(`${m}.py`));
    expect(missing).toEqual([]);
  });

  it("ships nothing that is not a module of the handlers", () => {
    expect([...exclude].filter((f) => !modules.includes(f.slice(0, -3)))).toEqual([]);
  });
});
