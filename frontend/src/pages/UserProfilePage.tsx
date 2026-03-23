import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getUserProjects, type ProjectResponse } from '../services/projectService';
import { useAuthStore } from '../store/useAuthStore';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import './UserProfilePage.css';

export const UserProfilePage: React.FC = () => {
  const { username } = useParams<{ username: string }>();

  useSEO({
    title: `${username ?? 'User'} — Velxio Profile`,
    description: `View Arduino and ESP32 projects by ${username ?? 'this user'} on Velxio.`,
    url: `https://velxio.dev/${username ?? ''}`,
    noindex: true,
  });
  const user = useAuthStore((s) => s.user);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    getUserProjects(username)
      .then(setProjects)
      .catch(() => setError('User not found.'))
      .finally(() => setLoading(false));
  }, [username]);

  const isOwn = user?.username === username;

  return (
    <div className="profile-page">
      <AppHeader />
      <div className="profile-container">
        <div className="profile-header">
          <div className="profile-avatar">{username?.[0]?.toUpperCase()}</div>
          <h1 className="profile-username">{username}</h1>
          {isOwn && (
            <Link to="/editor" className="profile-new-btn">+ New project</Link>
          )}
        </div>

        {loading && <p className="profile-muted">Loading…</p>}
        {error && <p className="profile-error">{error}</p>}
        {!loading && !error && projects.length === 0 && (
          <p className="profile-muted">No public projects yet.</p>
        )}

        <div className="profile-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/${username}/${p.slug}`} className="profile-card">
              <div className="profile-card-title">{p.name}</div>
              {p.description && <div className="profile-card-desc">{p.description}</div>}
              <div className="profile-card-meta">
                <span className="profile-badge">{p.board_type}</span>
                {!p.is_public && <span className="profile-badge profile-badge-private">Private</span>}
                <span className="profile-date">{new Date(p.updated_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
