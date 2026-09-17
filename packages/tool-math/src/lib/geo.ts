/**
 * Geospatial arithmetic on a SPHERE: great-circle distance, bounding boxes
 * and point-in-polygon.
 *
 * The Earth is modelled as a sphere of radius 6 371 008.8 m — the IUGG mean
 * radius R1 of the WGS-84 ellipsoid. That is stated in every result because
 * it is the source of the error: a spherical model differs from the true
 * ellipsoid by up to about 0.5% depending on latitude and bearing, which is
 * fine for "how far apart are these two warehouses" and not fine for
 * surveying. Anything needing better should use Vincenty or GeographicLib on
 * the ellipsoid.
 *
 * The haversine formulation is used rather than the spherical law of cosines
 * because the latter loses precision for short distances, where the cosine of
 * a tiny angle is 1 to within floating-point noise.
 *
 * Coordinates are degrees, latitude in [-90, 90] and longitude in [-180, 180].
 * Nothing here reprojects: a polygon test is done in plain lon/lat space, so
 * a polygon that crosses the antimeridian is refused rather than silently
 * turned inside out.
 */

/** IUGG mean radius R1 of the WGS-84 ellipsoid, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

export class GeoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoError";
  }
}

export type Point = { lat: number; lon: number };

export const MAX_POINTS = 100_000;
export const MAX_POLYGON_VERTICES = 100_000;

export function assertPoint(point: Point, label: string): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    throw new GeoError(`${label} must have finite lat and lon`);
  }
  if (point.lat < -90 || point.lat > 90) {
    throw new GeoError(`${label} latitude ${point.lat} is outside [-90, 90]`);
  }
  if (point.lon < -180 || point.lon > 180) {
    throw new GeoError(`${label} longitude ${point.lon} is outside [-180, 180]`);
  }
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

export type DistanceResult = {
  metres: number;
  kilometres: number;
  miles: number;
  nauticalMiles: number;
  initialBearingDegrees: number;
  radiusMetres: number;
  method: string;
};

/** Great-circle distance by the haversine formula, plus the initial bearing. */
export function haversineDistance(a: Point, b: Point, radiusMetres: number): DistanceResult {
  assertPoint(a, "from");
  assertPoint(b, "to");
  // `> 0` alone lets Infinity through, and an infinite radius makes every
  // distance Infinity — which JSON renders as `null`, a blank where a number
  // should be rather than a refusal.
  if (!(radiusMetres > 0) || !Number.isFinite(radiusMetres)) {
    throw new GeoError("the radius must be a finite number greater than zero");
  }
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const metres = 2 * radiusMetres * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearing = (toDegrees(Math.atan2(y, x)) + 360) % 360;
  return {
    metres,
    kilometres: metres / 1000,
    // Exact definitions: 1 mile = 1609.344 m, 1 nautical mile = 1852 m.
    miles: metres / 1609.344,
    nauticalMiles: metres / 1852,
    initialBearingDegrees: bearing,
    radiusMetres,
    method: `haversine on a sphere of radius ${radiusMetres} m; up to ~0.5% from the WGS-84 ellipsoid`,
  };
}

export type BoundingBox = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  centerLat: number;
  centerLon: number;
  crossesAntimeridian: boolean;
  pointCount: number;
  note: string;
};

/**
 * The smallest lat/lon box containing every point.
 *
 * Longitude wraps, so there are two candidate boxes: the plain [min, max] and
 * the one that runs the other way across the antimeridian. The narrower span
 * wins, and `crossesAntimeridian` says which was chosen — when it is true,
 * minLon is GREATER than maxLon, which is the standard way to write a box
 * that straddles ±180.
 */
export function boundingBoxOf(points: ReadonlyArray<Point>): BoundingBox {
  if (points.length === 0) throw new GeoError("at least one point is required");
  if (points.length > MAX_POINTS) {
    throw new GeoError(`at most ${MAX_POINTS} points are supported, got ${points.length}`);
  }
  points.forEach((p, i) => assertPoint(p, `points[${i}]`));
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  const lons: number[] = [];
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    lons.push(p.lon);
  }
  lons.sort((a, b) => a - b);
  const first = lons[0] as number;
  const last = lons[lons.length - 1] as number;
  let minLon = first;
  let maxLon = last;
  let crosses = false;
  let plainSpan = last - first;
  // The widest gap between consecutive longitudes (wrapping around ±180) is
  // the part of the circle the points do NOT cover; the box is its complement.
  let gapIndex = -1;
  let widestGap = last - first === 0 ? 0 : 360 - (last - first);
  for (let i = 1; i < lons.length; i++) {
    const gap = (lons[i] as number) - (lons[i - 1] as number);
    if (gap > widestGap) {
      widestGap = gap;
      gapIndex = i;
    }
  }
  if (gapIndex >= 0) {
    const wrappedSpan = 360 - widestGap;
    if (wrappedSpan < plainSpan) {
      minLon = lons[gapIndex] as number;
      maxLon = lons[gapIndex - 1] as number;
      crosses = true;
      plainSpan = wrappedSpan;
    }
  }
  const centerLon = crosses ? normalizeLongitude(minLon + plainSpan / 2) : (minLon + maxLon) / 2;
  return {
    minLat,
    maxLat,
    minLon,
    maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon,
    crossesAntimeridian: crosses,
    pointCount: points.length,
    note: crosses
      ? "the box crosses the antimeridian, so minLon > maxLon: a longitude is inside when it is >= minLon OR <= maxLon"
      : "a longitude is inside when it is between minLon and maxLon",
  };
}

export function normalizeLongitude(lon: number): number {
  let value = ((lon + 180) % 360) - 180;
  if (value <= -180) value += 360;
  return value;
}

export type RadiusBox = BoundingBox & { radiusMetres: number };

/**
 * The lat/lon box that contains every point within `radiusMetres` of a
 * centre — the cheap pre-filter you run before an exact distance test.
 *
 * The longitude delta grows as 1/cos(latitude), so near the poles the box
 * widens to the whole world; that case is reported rather than producing a
 * nonsense narrow box. The box is a superset of the circle, never a subset,
 * so filtering with it cannot drop a point that is genuinely in range.
 */
export function boundingBoxAround(
  center: Point,
  radiusMetres: number,
  earthRadius: number,
): RadiusBox {
  assertPoint(center, "center");
  if (!(radiusMetres > 0) || !Number.isFinite(radiusMetres)) {
    throw new GeoError("the radius must be a finite number greater than zero");
  }
  if (!(earthRadius > 0) || !Number.isFinite(earthRadius)) {
    throw new GeoError("the Earth radius must be a finite number greater than zero");
  }
  const angular = radiusMetres / earthRadius;
  if (angular >= Math.PI) {
    return {
      minLat: -90,
      maxLat: 90,
      minLon: -180,
      maxLon: 180,
      centerLat: center.lat,
      centerLon: center.lon,
      crossesAntimeridian: false,
      pointCount: 0,
      radiusMetres,
      note: "the radius covers the whole planet",
    };
  }
  const minLat = center.lat - toDegrees(angular);
  const maxLat = center.lat + toDegrees(angular);
  if (minLat <= -90 || maxLat >= 90) {
    return {
      minLat: Math.max(-90, minLat),
      maxLat: Math.min(90, maxLat),
      minLon: -180,
      maxLon: 180,
      centerLat: center.lat,
      centerLon: center.lon,
      crossesAntimeridian: false,
      pointCount: 0,
      radiusMetres,
      note: "the circle reaches a pole, so every longitude is inside the box",
    };
  }
  const latRadians = toRadians(center.lat);
  const deltaLon = toDegrees(Math.asin(Math.sin(angular) / Math.cos(latRadians)));
  const rawMin = center.lon - deltaLon;
  const rawMax = center.lon + deltaLon;
  const crosses = rawMin < -180 || rawMax > 180;
  return {
    minLat,
    maxLat,
    minLon: normalizeLongitude(rawMin),
    maxLon: normalizeLongitude(rawMax),
    centerLat: center.lat,
    centerLon: center.lon,
    crossesAntimeridian: crosses,
    pointCount: 0,
    radiusMetres,
    note: crosses
      ? "the box crosses the antimeridian, so minLon > maxLon: a longitude is inside when it is >= minLon OR <= maxLon"
      : "a superset of the circle: every point within the radius is inside the box, but not every point in the box is within the radius",
  };
}

export type PointInPolygonResult = {
  inside: boolean;
  onBoundary: boolean;
  vertexCount: number;
  crossings: number;
  method: string;
};

/**
 * Ray casting (the even-odd rule) in plain lon/lat space.
 *
 * A horizontal ray is cast east from the point and the edge crossings are
 * counted: odd means inside. A point lying exactly ON an edge or vertex is
 * ambiguous under that rule, so it is detected first and reported as
 * `onBoundary: true` with `inside: true`, rather than being decided by
 * floating-point luck.
 *
 * The ring may be given open or closed (a repeated first vertex is fine).
 * Self-intersecting rings are the caller's problem: the even-odd rule will
 * answer, but "inside" stops meaning what they expect. A ring spanning more
 * than 180° of longitude is refused, since it is almost certainly an
 * antimeridian crossing that this planar test would read backwards.
 */
export function pointInPolygon(point: Point, ring: ReadonlyArray<Point>): PointInPolygonResult {
  assertPoint(point, "point");
  if (ring.length < 3) throw new GeoError("a polygon ring needs at least 3 vertices");
  if (ring.length > MAX_POLYGON_VERTICES) {
    throw new GeoError(`at most ${MAX_POLYGON_VERTICES} vertices are supported`);
  }
  ring.forEach((p, i) => assertPoint(p, `polygon[${i}]`));
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const v of ring) {
    if (v.lon < minLon) minLon = v.lon;
    if (v.lon > maxLon) maxLon = v.lon;
  }
  if (maxLon - minLon > 180) {
    throw new GeoError(
      `the ring spans ${(maxLon - minLon).toFixed(3)}° of longitude, which this planar test reads as wrapping the wrong way round the globe — split the polygon at the antimeridian first`,
    );
  }
  const vertices = [...ring];
  const first = vertices[0] as Point;
  const last = vertices[vertices.length - 1] as Point;
  if (first.lat === last.lat && first.lon === last.lon) vertices.pop();
  if (vertices.length < 3) throw new GeoError("a polygon ring needs at least 3 distinct vertices");

  const x = point.lon;
  const y = point.lat;
  let crossings = 0;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i] as Point;
    const b = vertices[j] as Point;
    if (onSegment(x, y, a, b)) {
      return {
        inside: true,
        onBoundary: true,
        vertexCount: vertices.length,
        crossings: 0,
        method:
          "ray casting (even-odd); the point lies exactly on an edge, which is reported as inside",
      };
    }
    const intersects =
      a.lat > y !== b.lat > y && x < ((b.lon - a.lon) * (y - a.lat)) / (b.lat - a.lat) + a.lon;
    if (intersects) crossings++;
  }
  return {
    inside: crossings % 2 === 1,
    onBoundary: false,
    vertexCount: vertices.length,
    crossings,
    method: "ray casting (even-odd rule) in planar lon/lat space, not on the sphere",
  };
}

function onSegment(x: number, y: number, a: Point, b: Point): boolean {
  const cross = (b.lon - a.lon) * (y - a.lat) - (b.lat - a.lat) * (x - a.lon);
  if (cross !== 0) return false;
  return (
    Math.min(a.lon, b.lon) <= x &&
    x <= Math.max(a.lon, b.lon) &&
    Math.min(a.lat, b.lat) <= y &&
    y <= Math.max(a.lat, b.lat)
  );
}
