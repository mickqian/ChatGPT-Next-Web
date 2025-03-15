import { getServerSideConfig } from "@/app/config/server";
import {
  ALIBABA_BASE_URL,
  ModelProvider,
  ServiceProvider,
} from "@/app/constant";
import { prettyObject } from "@/app/utils/format";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { isModelNotavailableInServer } from "@/app/utils/model";

const serverConfig = getServerSideConfig();

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  console.log("[Alibaba Route] params ", params);

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const authResult = auth(req, ModelProvider.Qwen);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  try {
    const response = await request(req);
    return response;
  } catch (e) {
    console.error("[Alibaba] ", e);
    return NextResponse.json(prettyObject(e));
  }
}

async function printReadableStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // 将 Uint8Array 转换为字符串并累加到结果中
      result += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    console.error("Error reading stream:", error);
  } finally {
    reader.releaseLock();
  }

  console.log("Stream content:", result);
}

async function request(req: NextRequest) {
  const controller = new AbortController();

  // alibaba use base url or just remove the path
  let Alibaba_PATH = "/api/alibaba/";

  let path = `${req.nextUrl.pathname}`.replaceAll(Alibaba_PATH, "");
  console.log("[Path] ", path);
  let baseUrl = serverConfig.alibabaUrl || ALIBABA_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Url] ", req.nextUrl);
  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);
  // console.log("[Body]", req.body);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  const fetchUrl = `${baseUrl}/${path}`;
  console.log("[fetchUrl]", fetchUrl);
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.get("Authorization") ?? "",
      "X-DashScope-SSE": req.headers.get("X-DashScope-SSE") ?? "disable",
    },
    method: req.method,
    body: req.body,
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // console.log(util.inspect(fetchOptions, { showHidden: true, depth: null, colors: true }));

  // console.log("[fetchOptions]", JSON.stringify(fetchOptions));
  // console.log("[req]", JSON.stringify(req));
  // console.log("[serverConfig.customModels] ", serverConfig.customModels);

  // #1815 try to refuse some request to some models
  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      console.log("104 [fetchOptions]", JSON.stringify(fetchOptions));

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          ServiceProvider.Alibaba as string,
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error(`[Alibaba] filter`, e);
    }
  }
  try {
    console.log("[body]", JSON.stringify(fetchOptions.body));
    // console.log("[body]", fetchOptions);

    // printReadableStream(fetchOptions.body)

    const res = await fetch(fetchUrl, fetchOptions);

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
