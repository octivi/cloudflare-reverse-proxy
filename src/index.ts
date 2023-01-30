/**
 * Copyright (C) 2023  IMAGIN Sp. z o.o.
 * Author: Marcin Engelmann <mengelmann@octivi.com>
 *
 * Cloudflare Workers as a reverse proxy. Route traffic from a (sub)domain
 * to a subdirectory using Cloudflare Workers. Parse and transform URLs in HTML.
 *
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Inform TypeScript about global variables
type EnvType = {
  ORIGIN_URL: string;
  PUBLIC_URL: string;
};

export default {
  async fetch(request: Request, env: EnvType): Promise<Response> {
    // Get URLs from environmental variables
    // https://developers.cloudflare.com/workers/platform/environment-variables/
    const originUrl = env.ORIGIN_URL;
    const publicUrl = env.PUBLIC_URL;

    const rewriteWordpressUrls =
      (originUrl: string, publicUrl: string) =>
      (text: string | null): string => {
        if (text == null) return "";

        const originURL = new URL(originUrl);
        const publicURL = new URL(publicUrl);

        return (
          text
            // Relative URLs
            .replaceAll("'/wp-content/", `'${publicUrl}/wp-content/`)
            .replaceAll('"/wp-content/', `"${publicUrl}/wp-content/`)
            .replaceAll("</wp-content/", `<${publicUrl}/wp-content/`)
            // URLs with escaped "/" in JavaScript/JSON
            .replaceAll(
              `${originURL.origin.replaceAll("/", "\\/")}`,
              `${publicURL.origin.replaceAll("/", "\\/")}${publicURL.pathname.replaceAll("/", "\\/")}`
            )
            // Full URL
            .replaceAll(originUrl, publicUrl)
            // Hostname and port
            .replaceAll(originURL.hostname, `${publicURL.hostname}:${publicURL.port}`)
        );
      };

    // Based on https://developers.cloudflare.com/workers/examples/respond-with-another-site/
    async function methodNotAllowed(request: Request): Promise<Response> {
      return new Response(`Method ${request.method} not allowed.`, {
        status: 405,
        headers: {
          Allow: "GET",
        },
      });
    }

    // Rewrite URLs in HTML attributes (href in <a>, src in <img> and so on)
    // Based on https://developers.cloudflare.com/workers/examples/rewrite-links/
    class AttributeRewriter {
      constructor(private attributeName: string, private rewriter: (text: string) => string) {}

      element(element: Element): void {
        const attributeValue = element.getAttribute(this.attributeName);

        if (attributeValue) element.setAttribute(this.attributeName, this.rewriter(attributeValue));
      }
    }

    // Rewrite URLs in text inside HTML tags (<script>...</script>)
    // Text chunks may arrive in parts, so it is required to buffer them
    // https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/#text-chunks
    class TextRewriter {
      constructor(private rewriter: (text: string) => string, private buffer: string = "") {}

      text(text: Text): void {
        this.buffer += text.text;

        if (text.lastInTextNode) {
          // This is the last chunk, search&replace buffer and return to the client
          text.replace(this.rewriter(this.buffer), { html: true });
          this.buffer = "";
        } else {
          // This is not the last chunk. Remove it, so the client does not receive it
          text.remove();
        }
      }
    }

    // Only GET requests work with this proxy
    if (request.method !== "GET") return methodNotAllowed(request);

    // Prepare a new URL based on original one but with changed origin part (protocol, host, port) from originUrl
    const originURL = new URL(originUrl);
    const publicURL = new URL(publicUrl);
    const newRequestUrl = request.url.replace(publicUrl, originUrl);

    // Prepare a new request based on original one but with changed URL and some headers
    const newRequest = new Request(newRequestUrl, request);
    newRequest.headers.set("Host", originURL.hostname);
    newRequest.headers.set("X-Forwarded-Host", publicURL.hostname);
    newRequest.headers.set("X-Forwarded-Proto", publicURL.protocol);
    newRequest.headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") || "");

    // Send a new request and fetch a response
    const originResponse = await fetch(newRequest);

    // Clone the response so it is no longer immutable
    // Remove Robots-Tag header (probably contains noindex,nofollow)
    const response = new Response(originResponse.body, originResponse);
    const contentType = response.headers.get("Content-Type");
    const rewriteUrls = rewriteWordpressUrls(originUrl, publicUrl);
    response.headers.delete("X-Robots-Tag");

    // Rewrite link header (preloads)
    if (response.headers.has("link")) response.headers.set("link", rewriteUrls(response.headers.get("link")));

    // Rewrite URLs in response received from origin
    //   - from: originUrl
    //   -   to: publicUrl
    if (contentType?.startsWith("text/html")) {
      // Rewrite HTML files using CloudFlare's HTML Rewriter
      // https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
      const rewriter = new HTMLRewriter()
        .on("a", new AttributeRewriter("href", rewriteUrls))
        .on("form", new AttributeRewriter("action", rewriteUrls))
        .on("img", new AttributeRewriter("src", rewriteUrls))
        .on("img", new AttributeRewriter("srcset", rewriteUrls))
        .on("link", new AttributeRewriter("href", rewriteUrls))
        .on("meta", new AttributeRewriter("content", rewriteUrls))
        .on("script", new AttributeRewriter("src", rewriteUrls))
        .on("script", new TextRewriter(rewriteUrls))
        .on("style", new TextRewriter(rewriteUrls));
      return rewriter.transform(response);
    } else if (
      contentType?.startsWith("text/") ||
      contentType?.startsWith("application/x-javascript") ||
      contentType?.startsWith("application/javascript")
    ) {
      // Rewrite text files (CSS, JavaScript)
      const body = await response.text();
      const body_ = rewriteUrls(body);
      return new Response(body_, response);
    } else {
      // Can't and won't do anything with this content
      return response;
    }
  },
};
