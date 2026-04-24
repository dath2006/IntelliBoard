import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEditorStore } from "../../store/useEditorStore";
import {
  getMyProjects,
  type ProjectResponse,
} from "../../services/projectService";

interface OpenProjectModalProps {
  onClose: () => void;
  onNewProjectClick?: () => void;
}


export const OpenProjectModal: React.FC<OpenProjectModalProps> = ({
  onClose,
  onNewProjectClick,
}) => {

  const navigate = useNavigate();
  const hasUnsavedChanges = useEditorStore((s) =>
    Object.values(s.fileGroups).some((group) => group.some((f) => f.modified)),
  );

  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    getMyProjects()
      .then((items) => {
        const sorted = [...items].sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        );
        setProjects(sorted);
      })
      .catch((err) => {
        const status = err?.response?.status;
        if (status === 401) {
          setError("Sign in to open your saved projects.");
        } else {
          setError("Failed to load your projects.");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => {
      const name = p.name?.toLowerCase() ?? "";
      const desc = p.description?.toLowerCase() ?? "";
      const slug = p.slug?.toLowerCase() ?? "";
      return name.includes(q) || desc.includes(q) || slug.includes(q);
    });
  }, [projects, query]);

  const handleOpenProject = (projectId: string) => {
    if (
      hasUnsavedChanges &&
      !window.confirm("You have unsaved changes. Open another project anyway?")
    ) {
      return;
    }

    navigate(`/project/${projectId}`);
    onClose();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.headerRow}>
          <h2 style={styles.title}>Open saved project</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {onNewProjectClick && (
              <button
                style={styles.newProjectBtn}
                onClick={() => { onClose(); onNewProjectClick(); }}
                title="Create a new project"
              >
                + New project
              </button>
            )}
            <button style={styles.closeBtn} onClick={onClose} aria-label="Close">x</button>
          </div>
        </div>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, slug, or description"
          style={styles.searchInput}
          autoFocus
        />

        {loading && <p style={styles.mutedText}>Loading your projects...</p>}
        {!loading && error && <p style={styles.errorText}>{error}</p>}

        {!loading && !error && filteredProjects.length === 0 && (
          <p style={styles.mutedText}>
            {projects.length === 0
              ? "No saved projects yet."
              : "No projects match your search."}
          </p>
        )}

        {!loading && !error && filteredProjects.length > 0 && (
          <div style={styles.projectList}>
            {filteredProjects.map((project) => (
              <div key={project.id} style={styles.projectCard}>
                <div style={styles.projectMain}>
                  <div style={styles.projectTitle}>
                    {project.name || project.slug}
                  </div>
                  {project.description && (
                    <div style={styles.projectDesc}>{project.description}</div>
                  )}
                  <div style={styles.metaRow}>
                    <span style={styles.badge}>{project.board_type}</span>
                    <span
                      style={{
                        ...styles.badge,
                        ...(project.is_public
                          ? styles.publicBadge
                          : styles.privateBadge),
                      }}
                    >
                      {project.is_public ? "Public" : "Private"}
                    </span>
                    <span style={styles.dateText}>
                      Updated{" "}
                      {new Date(project.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <button
                  style={styles.openBtn}
                  onClick={() => handleOpenProject(project.id)}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.62)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    width: "min(820px, 92vw)",
    maxHeight: "80vh",
    background: "#1f1f1f",
    border: "1px solid #3c3c3c",
    borderRadius: 10,
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  title: {
    margin: 0,
    color: "#ddd",
    fontSize: 18,
    fontWeight: 600,
  },
  newProjectBtn: {
    background: "#1a3a6b",
    border: "1px solid #2d5aa0",
    borderRadius: 6,
    color: "#7cb9ff",
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  closeBtn: {
    background: "transparent",
    border: "1px solid #555",
    color: "#aaa",
    borderRadius: 6,
    width: 30,
    height: 30,
    cursor: "pointer",
    lineHeight: 1,
  },
  searchInput: {
    background: "#2b2b2b",
    border: "1px solid #4a4a4a",
    borderRadius: 6,
    color: "#ddd",
    padding: "9px 11px",
    fontSize: 14,
    outline: "none",
  },
  mutedText: {
    color: "#9a9a9a",
    fontSize: 13,
    margin: "4px 0",
  },
  errorText: {
    color: "#f87171",
    fontSize: 13,
    margin: "4px 0",
  },
  projectList: {
    border: "1px solid #303030",
    borderRadius: 8,
    overflowY: "auto",
    background: "#171717",
  },
  projectCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    borderBottom: "1px solid #2a2a2a",
  },
  projectMain: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  projectTitle: {
    color: "#e3e3e3",
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  projectDesc: {
    color: "#a9a9a9",
    fontSize: 12,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%",
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  badge: {
    background: "#2c2c2c",
    color: "#d0d0d0",
    border: "1px solid #454545",
    borderRadius: 99,
    fontSize: 11,
    padding: "2px 8px",
  },
  publicBadge: {
    borderColor: "#2f6f4d",
    color: "#7ee2a8",
  },
  privateBadge: {
    borderColor: "#7c5e2b",
    color: "#f2c46f",
  },
  dateText: {
    color: "#8f8f8f",
    fontSize: 11,
  },
  openBtn: {
    background: "#0e639c",
    border: "none",
    borderRadius: 6,
    color: "#fff",
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    flexShrink: 0,
  },
};
