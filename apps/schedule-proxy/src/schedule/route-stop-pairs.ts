export type Direction = "0" | "1";

export interface RouteStopPair {
  routeId: string;
  stopId: string;
  // Seconds, 0 when the field is blank
  walkTime: number;
  direction: Direction | null;
}

export interface Trip {
  routeId: string;
  stopId: string;
  directionId: string | null;
  // Unix seconds
  arrivalTime: number;
  departureTime: number;
}

export class InvalidRouteStopPairError extends Error {}

// "BRAY-HOWTH-I,8220IR0134,600,1;46A,8220DB000123,120"
export function parseRouteStopPairs(raw: string): RouteStopPair[] {
  return raw.split(";").map((pair) => {
    const [routeId = "", stopId = "", walkTime = "", direction = ""] = pair
      .split(",")
      .map((part) => part.trim());

    if (walkTime !== "" && !/^\d+$/.test(walkTime)) {
      throw new InvalidRouteStopPairError(
        "Invalid walk time; must be a whole number of seconds, 0 or more",
      );
    }

    if (direction !== "" && direction !== "0" && direction !== "1") {
      throw new InvalidRouteStopPairError(
        `Invalid direction "${direction}"; must be 0 or 1`,
      );
    }

    return {
      routeId,
      stopId,
      walkTime: walkTime === "" ? 0 : Number(walkTime),
      direction: direction === "" ? null : direction,
    };
  });
}

// Upstream only ever sees routeId,stopId[,offset]. A Walk time goes up as a
// negative offset, so upstream drops trips departing too soon before applying
// its limit. Malformed pairs are kept as they are so upstream rejects them the
// way it always has
export function toUpstreamRouteStopPairs(pairs: RouteStopPair[]): string {
  return pairs
    .map(({ routeId, stopId, walkTime }) =>
      walkTime === 0
        ? `${routeId},${stopId}`
        : `${routeId},${stopId},-${walkTime}`,
    )
    .join(";");
}

export function applyDirectionFilters<
  T extends Pick<Trip, "routeId" | "stopId" | "directionId">,
>(trips: T[], pairs: RouteStopPair[], limit: number): T[] {
  const directions = new Map(
    pairs
      .filter((pair) => pair.direction !== null)
      .map((pair) => [`${pair.routeId},${pair.stopId}`, pair.direction]),
  );

  return trips
    .filter((trip) => {
      const direction = directions.get(`${trip.routeId},${trip.stopId}`);
      // No filter on this pair, or the feed has no direction: keep it
      return (
        direction === undefined ||
        trip.directionId === null ||
        trip.directionId === direction
      );
    })
    .slice(0, limit);
}

// Upstream shifted each trip's times back by its pair's Walk time, so add it
// again to give the Device real times
export function restoreWalkTimes<T extends Trip>(
  trips: T[],
  pairs: RouteStopPair[],
): T[] {
  const walkTimes = new Map<string, number>();
  for (const { routeId, stopId, walkTime } of pairs) {
    const key = `${routeId},${stopId}`;
    // Upstream uses the first pair for a route and stop
    if (!walkTimes.has(key)) walkTimes.set(key, walkTime);
  }

  return trips.map((trip) => {
    const walkTime = walkTimes.get(`${trip.routeId},${trip.stopId}`) ?? 0;
    return walkTime === 0
      ? trip
      : {
          ...trip,
          arrivalTime: trip.arrivalTime + walkTime,
          departureTime: trip.departureTime + walkTime,
        };
  });
}

export interface ScheduleOptions {
  // The client's own limit
  limit: number;
  // What upstream sorted by: departureTime when the client asked for
  // sortByDeparture, otherwise arrivalTime
  sortBy: "arrivalTime" | "departureTime";
}

// Turns upstream's trips into what the client asked for. Upstream sorted by
// times shifted back by each pair's Walk time, so once they're restored, pairs
// with different Walk times can be out of order: sort again before trimming
export function customizeSchedule<T extends Trip>(
  trips: T[],
  pairs: RouteStopPair[],
  { limit, sortBy }: ScheduleOptions,
): T[] {
  const restored = restoreWalkTimes(trips, pairs).sort(
    (a, b) => a[sortBy] - b[sortBy],
  );
  return applyDirectionFilters(restored, pairs, limit);
}
