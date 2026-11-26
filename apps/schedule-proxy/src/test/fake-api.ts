import { once } from "node:events";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { WebSocketServer } from "ws";

import { createServer } from "~/server";

export const DART = "BRAY-HOWTH-I";
export const PEARSE = "8220IR0134";

// The fake upstream's clock, in Unix seconds
export const NOW = 1_800_000_000;

// 12 trips at Pearse, 5 minutes apart starting a minute from NOW, alternating
// northbound (0) and southbound (1), as upstream would return them for an
// unfiltered pair
export const trips = Array.from({ length: 12 }, (_, i) => ({
  tripId: `trip-${i}`,
  routeId: DART,
  stopId: PEARSE,
  directionId: String(i % 2),
  arrivalTime: NOW + 60 + i * 300,
  departureTime: NOW + 90 + i * 300,
}));

// What upstream does with the pairs it receives: adds each pair's offset to its
// trips' times, drops trips no longer in the future, then applies the limit
function upstreamSchedule(routeStopPairs: string, limit: number) {
  const offsets = routeStopPairs.split(";").map((pair) => {
    const [routeId, stopId, offset] = pair.split(",");
    return { routeId, stopId, offset: Number(offset ?? 0) };
  });

  return trips
    .map((trip) => {
      const offset =
        offsets.find(
          (pair) =>
            pair.routeId === trip.routeId && pair.stopId === trip.stopId,
        )?.offset ?? 0;
      return {
        ...trip,
        arrivalTime: trip.arrivalTime + offset,
        departureTime: trip.departureTime + offset,
      };
    })
    .filter((trip) => trip.arrivalTime > NOW)
    .slice(0, limit);
}

// Stands in for upstream: records what it receives, and answers like it does
export class FakeApi {
  server: Server;
  wss: WebSocketServer;
  restRequests: IncomingMessage[] = [];
  wsRequests: IncomingMessage[] = [];
  wsMessages: {
    event: string;
    data: { routeStopPairs: string; limit: number };
  }[] = [];

  constructor() {
    this.server = createHttpServer((request, response) => {
      this.restRequests.push(request);
      const url = new URL(request.url ?? "", "http://localhost");
      const pairs = decodeURIComponent(url.pathname.replace("/schedule/", ""));

      if (
        pairs.split(";").some((pair) => {
          const [routeId, stopId] = pair.split(",");
          return !routeId || !stopId;
        })
      ) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message:
              "Invalid route-stop pair; must be in the format routeId,stopId[,offset]",
            error: "Bad Request",
            statusCode: 400,
          }),
        );
        return;
      }

      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 10);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ trips: upstreamSchedule(pairs, limit) }));
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (socket, request) => {
      this.wsRequests.push(request);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        this.wsMessages.push(message);

        if (message.event === "schedule:subscribe") {
          socket.send(JSON.stringify({ event: "heartbeat", data: null }));
          socket.send(
            JSON.stringify({
              event: "schedule",
              data: {
                trips: upstreamSchedule(
                  message.data.routeStopPairs,
                  message.data.limit,
                ),
              },
            }),
          );
        }
      });
    });
  }

  get url() {
    return `http://localhost:${(this.server.address() as AddressInfo).port}`;
  }

  reset() {
    this.restRequests = [];
    this.wsRequests = [];
    this.wsMessages = [];
  }
}

// Runs a schedule-proxy against a fresh FakeApi for the enclosing test file
export function useScheduleProxy() {
  const fakeApi = new FakeApi();
  const proxy = { fakeApi, server: {} as FastifyInstance, url: "" };

  beforeAll(async () => {
    fakeApi.server.listen(0);
    await once(fakeApi.server, "listening");
    proxy.server = await createServer({ apiUrl: fakeApi.url });
    proxy.url = await proxy.server.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await proxy.server.close();
    fakeApi.wss.close();
    fakeApi.server.close();
  });

  beforeEach(() => fakeApi.reset());

  return proxy;
}
