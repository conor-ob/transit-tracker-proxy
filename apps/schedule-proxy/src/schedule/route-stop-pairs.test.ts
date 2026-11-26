import { describe, expect, it } from "vitest";

import {
  applyDirectionFilters,
  customizeSchedule,
  InvalidRouteStopPairError,
  parseRouteStopPairs,
  type RouteStopPair,
  restoreWalkTimes,
  toUpstreamRouteStopPairs,
} from "~/schedule/route-stop-pairs";

describe("parseRouteStopPairs", () => {
  it("parses a Direction filter with a blank Walk time", () => {
    expect(parseRouteStopPairs("BRAY-HOWTH-I,8220IR0134,,1")).toEqual([
      {
        routeId: "BRAY-HOWTH-I",
        stopId: "8220IR0134",
        walkTime: 0,
        direction: "1",
      },
    ]);
  });

  it("parses a Walk time in seconds alongside a Direction filter", () => {
    expect(parseRouteStopPairs("BRAY-HOWTH-I,8220IR0134,600,0")).toEqual([
      {
        routeId: "BRAY-HOWTH-I",
        stopId: "8220IR0134",
        walkTime: 600,
        direction: "0",
      },
    ]);
  });

  it("parses pairs without a fourth field", () => {
    expect(
      parseRouteStopPairs(
        "46A,8220DB000123;46A,8220DB000124,0;46A,8220DB000125,120",
      ),
    ).toEqual([
      { routeId: "46A", stopId: "8220DB000123", walkTime: 0, direction: null },
      { routeId: "46A", stopId: "8220DB000124", walkTime: 0, direction: null },
      {
        routeId: "46A",
        stopId: "8220DB000125",
        walkTime: 120,
        direction: null,
      },
    ]);
  });

  it("trims whitespace around each field", () => {
    expect(parseRouteStopPairs(" 46A , 8220DB000123 , 60 , 1 ")).toEqual([
      { routeId: "46A", stopId: "8220DB000123", walkTime: 60, direction: "1" },
    ]);
  });

  it.each(["2", "-1", "north", "01"])('rejects Direction "%s"', (direction) => {
    expect(() => parseRouteStopPairs(`46A,8220DB000123,,${direction}`)).toThrow(
      new InvalidRouteStopPairError(
        `Invalid direction "${direction}"; must be 0 or 1`,
      ),
    );
  });

  it.each(["-300", "abc", "1.5", "1e3", "+60"])(
    'rejects Walk time "%s"',
    (walkTime) => {
      expect(() => parseRouteStopPairs(`46A,8220DB000123,${walkTime}`)).toThrow(
        new InvalidRouteStopPairError(
          "Invalid walk time; must be a whole number of seconds, 0 or more",
        ),
      );
    },
  );
});

describe("toUpstreamRouteStopPairs", () => {
  it("strips Direction filters and forwards each Walk time as a negative offset", () => {
    const pairs = parseRouteStopPairs(
      "BRAY-HOWTH-I,8220IR0134,,1;BRAY-HOWTH-I,8220IR0135,600,0;46A,8220DB000123,0;46A,8220DB000124",
    );

    expect(toUpstreamRouteStopPairs(pairs)).toBe(
      "BRAY-HOWTH-I,8220IR0134;BRAY-HOWTH-I,8220IR0135,-600;46A,8220DB000123;46A,8220DB000124",
    );
  });
});

describe("applyDirectionFilters", () => {
  const trip = (
    routeId: string,
    stopId: string,
    directionId: string | null,
  ) => ({
    routeId,
    stopId,
    directionId,
  });

  const southbound: RouteStopPair = {
    routeId: "BRAY-HOWTH-I",
    stopId: "8220IR0134",
    walkTime: 0,
    direction: "1",
  };

  it("drops trips travelling in the other Direction", () => {
    const trips = [
      trip("BRAY-HOWTH-I", "8220IR0134", "0"),
      trip("BRAY-HOWTH-I", "8220IR0134", "1"),
      trip("BRAY-HOWTH-I", "8220IR0134", "0"),
    ];

    expect(applyDirectionFilters(trips, [southbound], 20)).toEqual([
      trip("BRAY-HOWTH-I", "8220IR0134", "1"),
    ]);
  });

  it("keeps trips with a null directionId", () => {
    const trips = [trip("BRAY-HOWTH-I", "8220IR0134", null)];

    expect(applyDirectionFilters(trips, [southbound], 20)).toEqual(trips);
  });

  it("leaves pairs without a Direction filter untouched", () => {
    const pairs: RouteStopPair[] = [
      southbound,
      { routeId: "46A", stopId: "8220DB000123", walkTime: 0, direction: null },
    ];
    const trips = [
      trip("46A", "8220DB000123", "0"),
      trip("BRAY-HOWTH-I", "8220IR0134", "0"),
      trip("46A", "8220DB000123", "1"),
    ];

    expect(applyDirectionFilters(trips, pairs, 20)).toEqual([
      trip("46A", "8220DB000123", "0"),
      trip("46A", "8220DB000123", "1"),
    ]);
  });

  it("only filters the same route at the same stop", () => {
    const trips = [
      trip("BRAY-HOWTH-I", "8220IR0135", "0"),
      trip("46A", "8220IR0134", "0"),
    ];

    expect(applyDirectionFilters(trips, [southbound], 20)).toEqual(trips);
  });

  it("trims to the limit after filtering", () => {
    const trips = [
      trip("BRAY-HOWTH-I", "8220IR0134", "0"),
      trip("BRAY-HOWTH-I", "8220IR0134", "1"),
      trip("BRAY-HOWTH-I", "8220IR0134", "0"),
      trip("BRAY-HOWTH-I", "8220IR0134", "1"),
      trip("BRAY-HOWTH-I", "8220IR0134", "1"),
    ];

    expect(applyDirectionFilters(trips, [southbound], 2)).toHaveLength(2);
    expect(applyDirectionFilters(trips, [southbound], 5)).toHaveLength(3);
  });
});

describe("restoreWalkTimes", () => {
  const trip = (routeId: string, stopId: string, time: number) => ({
    routeId,
    stopId,
    directionId: "0",
    arrivalTime: time,
    departureTime: time + 30,
  });

  it("adds each pair's own Walk time back to its trips' times", () => {
    const pairs = parseRouteStopPairs(
      "BRAY-HOWTH-I,8220IR0134,600,0;46A,8220DB000123,120",
    );
    const trips = [
      trip("BRAY-HOWTH-I", "8220IR0134", 1_800_000_000),
      trip("46A", "8220DB000123", 1_800_000_000),
    ];

    expect(restoreWalkTimes(trips, pairs)).toEqual([
      trip("BRAY-HOWTH-I", "8220IR0134", 1_800_000_600),
      trip("46A", "8220DB000123", 1_800_000_120),
    ]);
  });

  it("leaves trips on pairs without a Walk time unchanged", () => {
    const pairs = parseRouteStopPairs("46A,8220DB000123;46A,8220DB000124,0");
    const trips = [
      trip("46A", "8220DB000123", 1_800_000_000),
      trip("46A", "8220DB000124", 1_800_000_000),
    ];

    expect(restoreWalkTimes(trips, pairs)).toEqual(trips);
  });

  it("uses the first pair's Walk time when a route and stop appear twice, as upstream does", () => {
    const pairs = parseRouteStopPairs(
      "46A,8220DB000123,120;46A,8220DB000123,600",
    );

    expect(
      restoreWalkTimes([trip("46A", "8220DB000123", 1_800_000_000)], pairs),
    ).toEqual([trip("46A", "8220DB000123", 1_800_000_120)]);
  });
});

describe("customizeSchedule", () => {
  // Real times: the DART departs 10:12 with a 10-minute Walk time, the bus
  // 10:05 with a 2-minute one. Upstream sorted them by shifted time
  // (10:02, 10:03), so restored they're out of order
  const at = (minutes: number) => 1_800_000_000 + minutes * 60;
  const pairs = parseRouteStopPairs(
    "BRAY-HOWTH-O,8250IR0111,600,0;3_111_e_a,8250DB003062,120",
  );
  const fromUpstream = [
    {
      tripId: "dart",
      routeId: "BRAY-HOWTH-O",
      stopId: "8250IR0111",
      directionId: "0",
      arrivalTime: at(2) - 30,
      departureTime: at(2),
    },
    {
      tripId: "bus",
      routeId: "3_111_e_a",
      stopId: "8250DB003062",
      directionId: "1",
      arrivalTime: at(3) + 60,
      departureTime: at(3),
    },
  ];

  it("orders trips by their real times once Walk times are restored", () => {
    expect(
      customizeSchedule(fromUpstream, pairs, {
        limit: 10,
        sortBy: "departureTime",
      }).map((trip) => [trip.tripId, trip.departureTime]),
    ).toEqual([
      ["bus", at(5)],
      ["dart", at(12)],
    ]);
  });

  it("orders by arrival time when asked to", () => {
    // Real arrivals: the DART 10:11:30, the bus 10:06
    expect(
      customizeSchedule(fromUpstream, pairs, {
        limit: 10,
        sortBy: "arrivalTime",
      }).map((trip) => trip.tripId),
    ).toEqual(["bus", "dart"]);
  });

  it("trims to the limit after ordering, keeping the soonest trip", () => {
    expect(
      customizeSchedule(fromUpstream, pairs, {
        limit: 1,
        sortBy: "departureTime",
      }).map((trip) => trip.tripId),
    ).toEqual(["bus"]);
  });

  it("applies Direction filters before trimming", () => {
    const southbound = parseRouteStopPairs(
      "BRAY-HOWTH-O,8250IR0111,600,1;3_111_e_a,8250DB003062,120",
    );

    expect(
      customizeSchedule(fromUpstream, southbound, {
        limit: 10,
        sortBy: "departureTime",
      }).map((trip) => trip.tripId),
    ).toEqual(["bus"]);
  });
});
