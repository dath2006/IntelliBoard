import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProjectById } from '../services/projectService';
import { useEditorStore } from '../store/useEditorStore';
import { useSimulatorStore } from '../store/useSimulatorStore';
import { useProjectStore } from '../store/useProjectStore';
import { useSEO } from '../utils/useSEO';
import { EditorPage } from './EditorPage';

const DOMAIN = 'https://velxio.dev';

interface ProjectMeta {
  name: string;
  description: string;
  ownerUsername: string;
  isPublic: boolean;
}

export const ProjectByIdPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const loadFiles = useEditorStore((s) => s.loadFiles);
  const { setComponents, setWires, setBoardType } = useSimulatorStore();
  const setCurrentProject = useProjectStore((s) => s.setCurrentProject);
  const clearCurrentProject = useProjectStore((s) => s.clearCurrentProject);
  const currentProject = useProjectStore((s) => s.currentProject);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [projectMeta, setProjectMeta] = useState<ProjectMeta | null>(null);

  // SEO: update once we have real project data; use generic noindex fallback until then.
  useSEO(
    projectMeta && projectMeta.isPublic
      ? {
          title: `${projectMeta.name} by ${projectMeta.ownerUsername} | Velxio`,
          description: projectMeta.description
            ? `${projectMeta.description} — Simulate and remix this Arduino project on Velxio.`
            : `Arduino project by ${projectMeta.ownerUsername}. View and simulate it free on Velxio.`,
          url: `${DOMAIN}/project/${id}`,
        }
      : {
          title: 'Project — Velxio Arduino Emulator',
          description: 'View and simulate this Arduino project on Velxio — free, open-source multi-board emulator.',
          url: `${DOMAIN}/editor`,
          noindex: true,
        }
  );

  useEffect(() => {
    if (!id) return;
    // If this project is already loaded in the store (e.g. navigated here
    // right after saving) skip the fetch to avoid overwriting unsaved state.
    if (currentProject?.id === id && ready) return;

    getProjectById(id)
      .then((project) => {
        // For new empty projects, files array is empty and code is "".
        // Provide a meaningful empty starter file rather than a blank one.
        let files = project.files;
        if (files.length === 0) {
          const code = project.code ?? "";
          // If there's legacy code content, use it; otherwise provide an empty sketch stub
          const content = code.trim()
            ? code
            : `// New project — board: ${project.board_type}\n// Use the Agent tab to build your circuit and code.\n`;
          files = [{ name: "sketch.ino", content }];
        }
        loadFiles(files);

        // Always set the board type via the legacy API for compatibility.
        // For boards not in the legacy enum (ESP32, attiny, etc.) this is a no-op,
        // but the canvas board is correctly seeded by the simulator store initial state.
        setBoardType(project.board_type as any);

        // Parse circuit state — clear to empty arrays if JSON is empty/malformed
        try {
          const comps = project.components_json
            ? JSON.parse(project.components_json)
            : [];
          const wires = project.wires_json
            ? JSON.parse(project.wires_json)
            : [];
          setComponents(Array.isArray(comps) ? comps : []);
          setWires(Array.isArray(wires) ? wires : []);
        } catch {
          setComponents([]);
          setWires([]);
        }

        setCurrentProject({
          id: project.id,
          slug: project.slug,
          ownerUsername: project.owner_username,
          isPublic: project.is_public,
        });
        setProjectMeta({
          name: project.name ?? 'Untitled Project',
          description: project.description ?? '',
          ownerUsername: project.owner_username ?? '',
          isPublic: project.is_public ?? false,
        });
        setReady(true);
      })
      .catch((err) => {
        const s = err?.response?.status;
        if (s === 404) setError('Project not found.');
        else if (s === 403) setError('This project is private.');
        else setError('Failed to load project.');
        clearCurrentProject();
      });
  }, [id]);


  if (error) {
    return (
      <div style={{ minHeight: '100vh', background: '#1e1e1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: '#f44747', fontSize: 16, textAlign: 'center' }}>
          <p>{error}</p>
          <button
            onClick={() => navigate('/')}
            style={{ marginTop: 12, background: '#0e639c', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 4, cursor: 'pointer' }}
          >
            Go home
          </button>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', background: '#1e1e1e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#9d9d9d' }}>Loading project…</p>
      </div>
    );
  }

  return <EditorPage />;
};
