"use client";

import { Check, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@agent-hq/ui";
import {
  ROOM_GALLERY_PLACEABLE_SLOTS,
  roomTemplates,
  type RoomLayoutDocument,
} from "@agent-hq/rooms";

export function RoomDesignerPanel({
  layout,
  sceneName,
  onChange,
  onSave,
  onReset,
  onClose,
  isSaving,
}: {
  layout: RoomLayoutDocument;
  sceneName: string;
  onChange: (layout: RoomLayoutDocument) => void;
  onSave: () => Promise<void> | void;
  onReset: () => void;
  onClose: () => void;
  isSaving: boolean;
}) {
  const updateSlot = (slotId: string, roomId: string) => {
    onChange({
      ...layout,
      placements: {
        ...layout.placements,
        [slotId]: roomId as RoomLayoutDocument["placements"][string],
      },
    });
  };

  return (
    <aside className="room-designer-panel" aria-label="Room designer">
      <div className="room-designer-panel__header">
        <div>
          <p className="eyebrow">LAYOUT MODE</p>
          <h3>Room designer</h3>
          <p className="room-designer-panel__meta">
            {sceneName} · {Object.keys(layout.placements).length} rooms placed
          </p>
        </div>
        <Button aria-label="Close room designer" onClick={onClose} size="icon" variant="ghost">
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      <div className="room-designer-panel__body">
        {ROOM_GALLERY_PLACEABLE_SLOTS.map((slot) => (
          <label className="room-slot" key={slot.id}>
            <span className="room-slot__copy">
              <span className="room-slot__name">{slot.id.replaceAll("-", " ")}</span>
              <span className="room-slot__size">
                {slot.category} · {slot.kind}
              </span>
            </span>
            <select
              value={layout.placements[slot.id] ?? ""}
              onChange={(event) => updateSlot(slot.id, event.target.value)}
            >
              <option value="">Empty slot</option>
              {roomTemplates
                .filter((room) => room.category === slot.category)
                .map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.label}
                  </option>
                ))}
            </select>
            {layout.placements[slot.id] ? (
              <Check className="room-slot__check" size={14} aria-hidden="true" />
            ) : null}
          </label>
        ))}
      </div>
      <div className="room-designer-panel__footer">
        <Button onClick={onReset} size="sm" variant="ghost">
          <RotateCcw size={14} aria-hidden="true" />
          Reset
        </Button>
        <Button disabled={isSaving} onClick={() => void onSave()} size="sm">
          <Save size={14} aria-hidden="true" />
          {isSaving ? "Saving…" : "Save layout"}
        </Button>
      </div>
    </aside>
  );
}
