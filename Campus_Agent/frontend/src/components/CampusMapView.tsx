import { FaceChip } from "./FaceChip";
import type { LocationInfo } from "../types";

/** 校园平面布局：百分比坐标（左上为原点）——对齐 campus_map.png 示意区 */
const MAP_LAYOUT: Record<string, { x: number; y: number; zone?: string }> = {
  rooftop: { x: 48, y: 10, zone: "sky" },
  library: { x: 50, y: 28, zone: "study" },
  classroom: { x: 28, y: 30, zone: "core" },
  hallway: { x: 40, y: 34, zone: "core" },
  club_room: { x: 72, y: 36, zone: "side" },
  playground: { x: 18, y: 58, zone: "out" },
  cafeteria: { x: 68, y: 38, zone: "life" },
  shop: { x: 82, y: 52, zone: "life" },
  dorm_gate: { x: 72, y: 62, zone: "dorm" },
  dorm_m1: { x: 62, y: 78, zone: "dorm" },
  dorm_m2: { x: 70, y: 84, zone: "dorm" },
  dorm_f1: { x: 80, y: 76, zone: "dorm" },
  dorm_f2: { x: 86, y: 82, zone: "dorm" },
  dorm_f3: { x: 90, y: 74, zone: "dorm" },
  dorm_f4: { x: 94, y: 84, zone: "dorm" },
};

const PREVIEW_SHOW = 5;
const MAP_BG = "/api/campus/assets/bgs/campus_map.png";

interface Props {
  locations: LocationInfo[];
  currentId: string;
  busy: boolean;
  weatherId?: string;
  onEnter: (locationId: string) => void;
  /** Click a person chip → travel + focus that student */
  onSelectPerson?: (locationId: string, studentId: string) => void;
}

export function CampusMapView({
  locations,
  currentId,
  busy,
  weatherId,
  onEnter,
  onSelectPerson,
}: Props) {
  const weatherClass = `campus-map has-art weather-${weatherId || "cloudy"}`;

  return (
    <div
      className={weatherClass}
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(12,20,18,.22), rgba(12,20,18,.45)), url(${MAP_BG})`,
      }}
    >
      <div className="campus-map-art-veil" aria-hidden />

      {locations.map((loc) => {
        const pos = MAP_LAYOUT[loc.id] || { x: 50, y: 50 };
        const here = loc.id === currentId;
        const count = loc.present_count ?? 0;
        const preview = (loc.present_preview ?? []).filter((p) => !p.is_pc);
        const shown = preview.slice(0, PREVIEW_SHOW);
        const overflow = Math.max(
          0,
          count - shown.length - (loc.present_preview?.some((p) => p.is_pc) ? 1 : 0),
        );

        return (
          <div
            key={loc.id}
            className={`map-pin zone-${pos.zone || "side"}${here ? " is-here" : ""}${
              count > 0 ? " has-people" : ""
            }`}
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
          >
            <button
              type="button"
              className="map-pin-hit"
              disabled={busy}
              onClick={() => onEnter(loc.id)}
              title={loc.blurb}
            >
              <span className="map-pin-dot" />
              <span className="map-pin-card">
                <strong>{loc.name}</strong>
                <em>{here ? "你在这里" : count > 0 ? `${count} 人` : "空"}</em>
              </span>
            </button>
            {shown.length > 0 && (
              <span className="map-pin-faces" role="group" aria-label={`${loc.name}在场`}>
                {shown.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="map-face-btn"
                    disabled={busy || !onSelectPerson}
                    title={`查看 ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectPerson?.(loc.id, p.id);
                    }}
                  >
                    <FaceChip
                      src={p.q_sprite?.path || p.sprite?.path}
                      name={p.name}
                      className="mini q-chip"
                    />
                  </button>
                ))}
                {overflow > 0 && <span className="map-pin-more">+{overflow}</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
