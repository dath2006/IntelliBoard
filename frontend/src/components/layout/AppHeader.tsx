import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../store/useAuthStore';
import { useProjectStore } from '../../store/useProjectStore';
import { ShareModal } from './ShareModal';
import { trackVisitGitHub, trackVisitDiscord } from '../../utils/analytics';

const GITHUB_URL = 'https://github.com/davidmonterocrespo24/velxio';
const DISCORD_URL = 'https://discord.gg/3mARjJrh4E';

interface AppHeaderProps {}

export const AppHeader: React.FC<AppHeaderProps> = () => {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const currentProject = useProjectStore((s) => s.currentProject);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    setDropdownOpen(false);
    await logout();
    navigate('/');
  };

  const isActive = (path: string) => (location.pathname === path ? ' header-nav-link-active' : '');

  return (
    <header className="app-header">
      <div className="header-content">
        <div className="header-left">
          {/* Brand */}
          <div className="header-brand">
            <img src="/favicon.svg" alt="" style={{ width: 32, height: 32 }} />
            <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="header-title" style={{ color: '#f8fafc', fontWeight: 800 }}>IntelliBoard</span>
            </Link>
          </div>

          {/* Main nav links (desktop) */}
          <nav className={'header-nav-links' + (menuOpen ? ' header-nav-open' : '')}>
            <Link to="/examples" className={'header-nav-link' + isActive('/examples')}>
              Examples
            </Link>
            <Link to="/editor" className={'header-nav-link' + isActive('/editor')}>
              Editor
            </Link>
          </nav>
        </div>

        {/* Right: share + auth + mobile hamburger */}
        <div className="header-right">
          {/* Share button — visible when a project is loaded */}
          {currentProject && location.pathname === '/editor' && (
            <button
              onClick={() => setShowShareModal(true)}
              style={{
                background: 'transparent',
                border: '1px solid #555',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                color: '#ccc',
                fontSize: 13,
              }}
              title="Share project"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Share
            </button>
          )}

          {/* Auth UI */}
          {user ? (
            <div style={{ position: 'relative' }} ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                style={{
                  background: 'transparent',
                  border: '1px solid #555',
                  borderRadius: 20,
                  padding: '3px 10px 3px 6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: '#ccc',
                  fontSize: 13,
                }}
              >
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt=""
                    style={{ width: 22, height: 22, borderRadius: '50%' }}
                  />
                ) : (
                  <div
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: '#0e639c',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      color: '#fff',
                      fontWeight: 600,
                    }}
                  >
                    {user.username[0].toUpperCase()}
                  </div>
                )}
                <span className="header-username-text">{user.username}</span>
              </button>

              {dropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '110%',
                    background: '#252526',
                    border: '1px solid #3c3c3c',
                    borderRadius: 6,
                    minWidth: 150,
                    zIndex: 100,
                    boxShadow: '0 4px 12px rgba(0,0,0,.4)',
                  }}
                >
                  <Link
                    to={`/${user.username}`}
                    onClick={() => setDropdownOpen(false)}
                    style={{
                      display: 'block',
                      padding: '9px 14px',
                      color: '#ccc',
                      textDecoration: 'none',
                      fontSize: 13,
                    }}
                  >
                    My projects
                  </Link>
                  <div style={{ borderTop: '1px solid #3c3c3c' }} />
                  <button
                    onClick={handleLogout}
                    style={{
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      padding: '9px 14px',
                      color: '#ccc',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <Link
                to="/login"
                style={{
                  color: '#ccc',
                  padding: '4px 10px',
                  fontSize: 13,
                  textDecoration: 'none',
                  border: '1px solid #555',
                  borderRadius: 4,
                }}
              >
                Sign in
              </Link>
              <Link
                to="/register"
                style={{
                  color: '#fff',
                  padding: '4px 10px',
                  fontSize: 13,
                  textDecoration: 'none',
                  background: '#0e639c',
                  borderRadius: 4,
                }}
              >
                Sign up
              </Link>
            </div>
          )}

          {/* Mobile hamburger */}
          <button
            className="header-hamburger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <span />
            <span />
            <span />
          </button>
        </div>
      </div>

      {showShareModal && <ShareModal onClose={() => setShowShareModal(false)} />}
    </header>
  );
};
