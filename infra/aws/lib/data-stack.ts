import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/** Where the pipeline's outputs and the raw FIRMS downloads live in the data bucket. */
export const DATA_LAYOUT = {
  harmonizedPrefix: "harmonized/",
  cellsKey: "harmonized/harmonized_cells.parquet",
  hotspotsKey: "harmonized/hotspots_harmonized.parquet",
  rawFirmsPrefix: "raw/firms/",
} as const;

/**
 * The data bucket outlives every other stack: the harmonized tables take a
 * full pipeline run to rebuild and the NRT downloads cannot be fetched again
 * once FIRMS rolls them out of its window, so it is retained on delete.
 */
export class DataStack extends Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "expire-old-versions",
          // A bad pipeline run can be rolled back for a month, not forever.
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });
  }
}
