import { describe, expect, it } from "vitest";

import {
  BUS,
  BUS_STOP,
  busTrips,
  DART,
  PEARSE,
  trips,
  useScheduleProxy,
} from "~/test/fake-api";

describe("REST schedule", () => {
  const proxy = useScheduleProxy();

  it("returns only southbound trips, up to the requested limit", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},,1`)}?limit=3`,
    );

    expect(response.statusCode).toBe(200);
    expect(
      response.json().trips.map((trip: { tripId: string }) => trip.tripId),
    ).toEqual(["trip-1", "trip-3", "trip-5"]);
  });

  it("asks upstream for its maximum limit, with the Walk time as a negative offset and without Direction filters", async () => {
    await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},300,1`)}?limit=3`,
    );

    expect(proxy.fakeApi.restRequests[0]?.url).toBe(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},-300`)}?limit=10`,
    );
  });

  it("hides trips that can't be caught in the Walk time, showing real times", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},600,1`)}?limit=3`,
    );

    // trip-1 departs 6 minutes from now, inside the 10-minute Walk time
    expect(response.json()).toEqual({
      trips: [trips[3], trips[5], trips[7]],
    });
  });

  it("restores each pair's own Walk time, in order of real arrival", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},600;${BUS},${BUS_STOP},120`)}?limit=3`,
    );

    // Upstream returns trip-2 before bus-0, sorted by their shifted times
    expect(response.json()).toEqual({
      trips: [busTrips[0], trips[2], busTrips[1]],
    });
  });

  it.each(["-300", "soon", "1.5"])(
    'rejects Walk time "%s" as a bad request',
    async (walkTime) => {
      const response = await proxy.server.inject(
        `/schedule/${encodeURIComponent(`${DART},${PEARSE},${walkTime}`)}`,
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        message:
          "Invalid walk time; must be a whole number of seconds, 0 or more",
        error: "Bad Request",
        statusCode: 400,
      });
      expect(proxy.fakeApi.restRequests).toHaveLength(0);
    },
  );

  it("returns exactly what upstream does without Direction filters", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE}`)}?limit=4`,
    );

    expect(response.json()).toEqual({ trips: trips.slice(0, 4) });
  });

  it("defaults to upstream's limit of 10", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE}`)}`,
    );

    expect(response.json().trips).toHaveLength(10);
  });

  it("accepts as many pairs as upstream allows", async () => {
    // Upstream's maximum of 25 pairs, with NTA-length IDs and Direction filters
    const pairs = Array.from(
      { length: 25 },
      (_, i) => `nta:3_${100 + i}_e_a,nta:8250DB0030${10 + i},600,0`,
    ).join(";");

    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(pairs)}`,
    );

    expect(response.statusCode).toBe(200);
    expect(proxy.fakeApi.restRequests).toHaveLength(1);
  });

  it("rejects an invalid Direction as a bad request", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(`${DART},${PEARSE},,north`)}`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe(
      'Invalid direction "north"; must be 0 or 1',
    );
    expect(proxy.fakeApi.restRequests).toHaveLength(0);
  });

  it("passes upstream errors through unchanged", async () => {
    const response = await proxy.server.inject(
      `/schedule/${encodeURIComponent(DART)}`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message:
        "Invalid route-stop pair; must be in the format routeId,stopId[,offset]",
      error: "Bad Request",
      statusCode: 400,
    });
  });
});
