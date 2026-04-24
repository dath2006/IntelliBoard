import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectStore } from "../../store/useProjectStore";
import { createProject } from "../../services/projectService";
import { BOARD_KIND_LABELS } from "../../types/board";
import type { BoardKind } from "../../types/board";

interface NewProjectModalProps {
  onClose: () => void;
}

// Board options with friendly grouping (same order as the simulator picker)
const BOARD_OPTIONS: { kind: BoardKind; label: string; group: string }[] = [
  // Arduino AVR
  { kind: "arduino-uno", label: "Arduino Uno", group: "Arduino AVR" },
  { kind: "arduino-nano", label: "Arduino Nano", group: "Arduino AVR" },
  { kind: "arduino-mega", label: "Arduino Mega 2560", group: "Arduino AVR" },
  { kind: "attiny85", label: "ATtiny85", group: "Arduino AVR" },
  // RP2040
  { kind: "raspberry-pi-pico", label: "Raspberry Pi Pico", group: "RP2040" },
  { kind: "pi-pico-w", label: "Raspberry Pi Pico W", group: "RP2040" },
  // ESP32
  { kind: "esp32", label: "ESP32 DevKit V1", group: "ESP32" },
  { kind: "esp32-devkit-c-v4", label: "ESP32 DevKit C V4", group: "ESP32" },
  { kind: "esp32-cam", label: "ESP32-CAM", group: "ESP32" },
  { kind: "wemos-lolin32-lite", label: "Wemos Lolin32 Lite", group: "ESP32" },
  { kind: "esp32-s3", label: "ESP32-S3 DevKit", group: "ESP32-S3" },
  { kind: "xiao-esp32-s3", label: "XIAO ESP32-S3", group: "ESP32-S3" },
  { kind: "arduino-nano-esp32", label: "Arduino Nano ESP32", group: "ESP32-S3" },
  { kind: "esp32-c3", label: "ESP32-C3 DevKit", group: "ESP32-C3" },
  { kind: "xiao-esp32-c3", label: "XIAO ESP32-C3", group: "ESP32-C3" },
  { kind: "aitewinrobot-esp32c3-supermini", label: "ESP32-C3 SuperMini", group: "ESP32-C3" },
  // Linux SBC
  { kind: "raspberry-pi-3", label: "Raspberry Pi 3B", group: "Linux SBC" },
];

export const NewProjectModal: React.FC<NewProjectModalProps> = ({ onClose }) => {
  const navigate = useNavigate();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [boardKind, setBoardKind] = useState<BoardKind>("arduino-uno");
  const [isPublic, setIsPublic] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required.");
      return;
    }
    setSaving(true);
    setError("");

    try {
      const saved = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        is_public: isPublic,
        board_type: boardKind,
        files: [],          // truly empty — the agent or user will add code
        code: "",
        components_json: "[]",
        wires_json: "[]",
      });

      setCurrentProject({
        id: saved.id,
        slug: saved.slug,
        ownerUsername: saved.owner_username,
        isPublic: saved.is_public,
      });

      navigate(`/project/${saved.id}`);
      onClose();
    } catch (err: any) {
      if (!err?.response) {
        setError("Server unreachable. Check your connection.");
      } else if (err.response.status === 401) {
        setError("Please sign in to create projects.");
      } else {
        setError(err.response?.data?.detail || `Create failed (${err.response.status}).`);
      }
    } finally {
      setSaving(false);
    }
  };

  // Group board options for the <select> optgroup structure
  const groups = BOARD_OPTIONS.reduce<Record<string, typeof BOARD_OPTIONS>>((acc, opt) => {
    if (!acc[opt.group]) acc[opt.group] = [];
    acc[opt.group].push(opt);
    return acc;
  }, {});

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div style={styles.headerRow}>
          <div>
            <h2 style={styles.title}>New project</h2>
            <p style={styles.subtitle}>Start from a clean canvas with your board of choice.</p>
          </div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleCreate} style={styles.form}>
          {/* Project name */}
          <div style={styles.fieldGroup}>
            <label style={styles.label} htmlFor="np-name">Project name *</label>
            <input
              id="np-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              style={styles.input}
              placeholder="My new project"
            />
          </div>

          {/* Description */}
          <div style={styles.fieldGroup}>
            <label style={styles.label} htmlFor="np-desc">Description</label>
            <input
              id="np-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={styles.input}
              placeholder="Optional description"
            />
          </div>

          {/* Board type */}
          <div style={styles.fieldGroup}>
            <label style={styles.label} htmlFor="np-board">
              Board type *
              <span style={styles.hint}> — you can change this later via the agent</span>
            </label>
            <select
              id="np-board"
              value={boardKind}
              onChange={(e) => setBoardKind(e.target.value as BoardKind)}
              style={styles.select}
            >
              {Object.entries(groups).map(([group, opts]) => (
                <optgroup key={group} label={group}>
                  {opts.map((o) => (
                    <option key={o.kind} value={o.kind}>{o.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* Selected board badge */}
            <div style={styles.boardBadge}>
              <span style={styles.boardBadgeDot} />
              <span style={{ fontSize: 12, color: "#a8c7fa" }}>
                {BOARD_KIND_LABELS[boardKind] ?? boardKind}
              </span>
            </div>
          </div>

          {/* Visibility */}
          <div
            style={styles.visibilityToggle}
            onClick={() => setIsPublic((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === "Enter" && setIsPublic((v) => !v)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {isPublic ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
              <div>
                <div style={{ color: isPublic ? "#4ade80" : "#f59e0b", fontSize: 13, fontWeight: 600 }}>
                  {isPublic ? "Public" : "Private"}
                </div>
                <div style={{ color: "#888", fontSize: 11 }}>
                  {isPublic ? "Anyone with the link can view" : "Only you can see this"}
                </div>
              </div>
            </div>
          </div>

          {/* Empty project note */}
          <div style={styles.emptyNote}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6b9cf5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              The project starts with an empty canvas and no code. Use the <strong>Agent</strong> tab
              to let the AI build your circuit, or add components manually.
            </span>
          </div>

          <div style={styles.actions}>
            <button type="submit" disabled={saving} style={styles.createBtn}>
              {saving ? "Creating…" : "Create project"}
            </button>
            <button type="button" onClick={onClose} style={styles.cancelBtn}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    width: "min(480px, 95vw)",
    background: "#1e2130",
    border: "1px solid #2d3250",
    borderRadius: 12,
    padding: "1.75rem",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,.6)",
  },
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  title: {
    margin: 0,
    color: "#e8eaf6",
    fontSize: 20,
    fontWeight: 700,
  },
  subtitle: {
    margin: "4px 0 0",
    color: "#7986cb",
    fontSize: 13,
  },
  closeBtn: {
    background: "transparent",
    border: "1px solid #3d4166",
    color: "#9fa8da",
    borderRadius: 6,
    width: 30,
    height: 30,
    cursor: "pointer",
    fontSize: 14,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  fieldGroup: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
  },
  label: {
    color: "#9fa8da",
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  hint: {
    color: "#5c6294",
    fontWeight: 400,
    textTransform: "none",
    letterSpacing: 0,
    fontSize: 11,
  },
  input: {
    background: "#252840",
    border: "1px solid #3d4166",
    borderRadius: 6,
    color: "#c5cae9",
    padding: "9px 11px",
    fontSize: 14,
    outline: "none",
    transition: "border-color 0.15s",
  },
  select: {
    background: "#252840",
    border: "1px solid #3d4166",
    borderRadius: 6,
    color: "#c5cae9",
    padding: "9px 11px",
    fontSize: 14,
    outline: "none",
    cursor: "pointer",
    appearance: "auto",
  },
  boardBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#1a1d2e",
    border: "1px solid #2d3250",
    borderRadius: 99,
    padding: "4px 10px",
    marginTop: 4,
    width: "fit-content",
  },
  boardBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#4f8ef7",
    flexShrink: 0,
  },
  visibilityToggle: {
    display: "flex",
    alignItems: "center",
    padding: "10px 12px",
    background: "#161826",
    border: "1px solid #2d3250",
    borderRadius: 8,
    cursor: "pointer",
    transition: "border-color 0.15s",
    userSelect: "none",
  },
  emptyNote: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    background: "#1a2040",
    border: "1px solid #2d3a60",
    borderRadius: 8,
    padding: "10px 12px",
    color: "#8899bb",
    fontSize: 12,
    lineHeight: 1.55,
  },
  actions: {
    display: "flex",
    gap: 8,
    marginTop: 2,
  },
  createBtn: {
    flex: 1,
    background: "linear-gradient(135deg, #3a5af7 0%, #1e3fcb 100%)",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    padding: "10px",
    fontSize: 14,
    cursor: "pointer",
    fontWeight: 600,
    letterSpacing: "0.02em",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid #3d4166",
    borderRadius: 6,
    color: "#9fa8da",
    padding: "10px 18px",
    fontSize: 14,
    cursor: "pointer",
  },
  error: {
    background: "#3b1a1a",
    border: "1px solid #f44747",
    borderRadius: 6,
    color: "#f44747",
    padding: "9px 12px",
    fontSize: 13,
  },
};
