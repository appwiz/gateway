import { Context, context, Span, SpanStatusCode } from "@opentelemetry/api";

import { PartialChatResponseType } from "@adaline/types";

import { GatewayError } from "../../errors/errors";
import { HttpClient, HttpRequestError, LoggerManager, TelemetryManager } from "../../plugins";
import { castToError } from "../../utils";
import type { ProxyStreamChatHandlerRequestType, ProxyStreamChatHandlerResponseType } from "./proxy-stream-chat.types";
import { ProxyStreamChatHandlerRequest } from "./proxy-stream-chat.types";

async function* handleProxyStreamChat(
  request: ProxyStreamChatHandlerRequestType,
  client: HttpClient,
  telemetryContext?: Context
): AsyncGenerator<ProxyStreamChatHandlerResponseType, void, unknown> {
  const logger = LoggerManager.getLogger();
  const _handleProxyStreamChat = async function* (span?: Span): AsyncGenerator<ProxyStreamChatHandlerResponseType, void, unknown> {
    logger?.debug("handleProxyStreamChat invoked");
    logger?.debug("handleProxyStreamChat request: ", { request });
    const handlerTelemetryContext = context.active();

    const data = ProxyStreamChatHandlerRequest.parse(request);

    try {
      const providerRequest = {
        url: await data.model.getProxyStreamChatUrl(data.data, data.headers, data.query),
        headers: data.headers,
        data: data.data,
      };

      providerRequest.headers = {
        ...providerRequest.headers,
        source: "adaline.ai",
      };

      const sanitizedProviderRequest = { ...providerRequest };
      delete sanitizedProviderRequest.headers.host;
      delete sanitizedProviderRequest.headers["content-length"];

      logger?.debug("handleProxyStreamChat providerRequest: ", { providerRequest });

      let buffer = "";
      for await (const chunk of client.stream(
        sanitizedProviderRequest.url,
        "post",
        sanitizedProviderRequest.data,
        sanitizedProviderRequest.headers,
        undefined,
        handlerTelemetryContext
      )) {
        let accumulatedPartialResponse: PartialChatResponseType[] = [];
        for await (const transformed of data.model.transformProxyStreamChatResponseChunk(
          chunk as string,
          buffer,
          data.data,
          data.headers,
          data.query
        )) {
          if (transformed.partialResponse.partialMessages.length > 0) {
            accumulatedPartialResponse.push(transformed.partialResponse);
          } else {
            buffer = transformed.buffer;
          }
        }
        const streamResponse: ProxyStreamChatHandlerResponseType = {
          request: providerRequest,
          providerRequest: sanitizedProviderRequest,
          providerResponse: chunk,
          transformedResponse: accumulatedPartialResponse,
        };

        logger?.debug("handleProxyStreamChat streamResponse: ", { streamResponse });
        yield streamResponse;
      }

      span?.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      logger?.warn("handleProxyStreamChat error: ", { error });
      let safeError: GatewayError | HttpRequestError;

      if (HttpRequestError.isHttpRequestError(error)) {
        safeError = error;
      } else if (error instanceof GatewayError) {
        safeError = error;
      } else {
        safeError = castToError(error);
      }

      throw safeError;
    } finally {
      span?.end();
    }
  };

  if (!telemetryContext) {
    return yield* _handleProxyStreamChat();
  }

  return yield* await context.with(telemetryContext, async () => {
    const tracer = TelemetryManager.getTracer();
    return await tracer.startActiveSpan("proxy-stream-chat.handler", async (span: Span) => {
      return await _handleProxyStreamChat(span);
    });
  });
}

export { handleProxyStreamChat };
