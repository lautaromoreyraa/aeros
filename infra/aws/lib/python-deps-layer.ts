import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AssetHashType } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LAYER_DIR = path.join(here, "..", "lambdas", "layer");

/** Python interpreters to try for local bundling, in order. */
function pythonCandidates(): string[] {
  return [process.env.PYTHON, "python3", "python"].filter((p): p is string => Boolean(p));
}

/**
 * DuckDB, H3 and DuckDB's httpfs for Python 3.12 on arm64, shared by the API
 * and the refresh functions.
 *
 * A zip layer instead of a container image: no ECR repository to pay for, and
 * the function code stays a few kilobytes. The build runs `lambdas/layer/build.py`
 * on the host, where pip fetches the Linux arm64 wheels directly, so synth needs
 * no Docker; only if no Python is found does CDK fall back to the Lambda build
 * image.
 */
export class PythonDepsLayer extends lambda.LayerVersion {
  constructor(scope: Construct, id: string) {
    super(scope, id, {
      description: "aeros: duckdb, h3 and the httpfs extension (python3.12 arm64)",
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      code: lambda.Code.fromAsset(LAYER_DIR, {
        // Rebuilt only when requirements.txt or build.py change.
        assetHashType: AssetHashType.SOURCE,
        exclude: ["__pycache__", ".ruff_cache"],
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          platform: "linux/arm64",
          command: ["bash", "-c", "python build.py /asset-output"],
          local: {
            tryBundle(outputDir: string): boolean {
              for (const python of pythonCandidates()) {
                const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
                if (probe.status !== 0) continue;
                const build = spawnSync(
                  python,
                  [path.join(LAYER_DIR, "build.py"), outputDir, "--cross"],
                  { stdio: "inherit" },
                );
                if (build.status !== 0) {
                  throw new Error(`layer build failed with ${python} (exit ${build.status})`);
                }
                return true;
              }
              return false;
            },
          },
        },
      }),
    });
  }
}
