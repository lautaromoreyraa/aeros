/**
 * A JSON `POST` that CloudFront can pass on to a Lambda function URL.
 *
 * Every `/api/*` path sits behind origin access control: CloudFront signs the
 * request for the function URL, and to sign a body it needs the body's SHA-256
 * in `x-amz-content-sha256`. It cannot compute the hash itself, so a POST
 * without the header is answered 403 before any function runs.
 */
export async function signedJsonPost(body: string): Promise<RequestInit> {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-amz-content-sha256": await sha256Hex(body) },
    body,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
