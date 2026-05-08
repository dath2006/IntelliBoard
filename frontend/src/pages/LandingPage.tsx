import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { trackVisitGitHub, trackClickCTA } from '../utils/analytics';
import { AppHeader } from '../components/layout/AppHeader';
import { useSEO } from '../utils/useSEO';
import { getSeoMeta } from '../seoRoutes';
import raspberryPi3Svg from '../assets/Raspberry_Pi_3_illustration.svg';
import './LandingPage.css';

const GITHUB_URL = 'https://github.com/dath2006/IntelliBoard';

/* ── Icons ───────────────────────────────────────────── */
const IcoZap = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const IcoGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

const IcoArrowRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
  </svg>
);

/* ── Types ─────────────────────────────────────────── */
type ExecutionMode = 'browser' | 'hybrid' | 'backend';

interface Board {
  name: string;
  chip: string;
  icon?: string;
  customIcon?: React.ReactNode;
  mode: ExecutionMode;
}

interface BoardGroup {
  id: string;
  name: string;
  engine: string;
  color: string;
  boards: Board[];
}

/* ── Custom Board Components ────────────────────────── */
const BoardATtiny85 = () => (
  <svg viewBox="0 0 60 50" className="board-svg-inline">
    <rect x="2" y="2" width="56" height="46" rx="2" fill="#1a3a1a" stroke="#0d2a0d" strokeWidth="1.5" />
    <rect x="18" y="12" width="24" height="28" rx="1" fill="#111" stroke="#2a2a2a" strokeWidth="1" />
    <path d="M28 12 Q30 9 32 12" fill="#222" stroke="#333" strokeWidth="0.5" />
    {[0, 1, 2, 3].map(i => <rect key={i} x="8" y={15+i*6} width="10" height="3.5" rx="0.5" fill="#d4a017" />)}
    {[0, 1, 2, 3].map(i => <rect key={i} x="42" y={15+i*6} width="10" height="3.5" rx="0.5" fill="#d4a017" />)}
  </svg>
);

const BoardCH32V003 = () => (
  <svg viewBox="0 0 60 80" className="board-svg-inline">
    <rect x="2" y="2" width="56" height="76" rx="2" fill="#0a2a0a" stroke="#061a06" strokeWidth="1.5" />
    <rect x="18" y="22" width="24" height="22" rx="1" fill="#1a1a1a" stroke="#2a2a2a" strokeWidth="1" />
    {[0, 1, 2, 3, 4, 5, 6].map(i => <rect key={i} x="0" y={8+i*9} width="4" height="5" rx="0.5" fill="#d4a017" />)}
    {[0, 1, 2, 3, 4, 5, 6].map(i => <rect key={i} x="56" y={8+i*9} width="4" height="5" rx="0.5" fill="#d4a017" />)}
    <rect x="20" y="70" width="20" height="7" rx="2" fill="#555" />
  </svg>
);

/* ── Content Data ────────────────────────────────────── */
const boardGroups: BoardGroup[] = [
  {
    id: 'avr',
    name: 'AVR8 Architecture',
    engine: 'avr8js',
    color: '#00f2ff', /* Electric Cyan */
    boards: [
      { name: 'Arduino Uno', chip: 'ATmega328P', icon: '/boards/arduino-uno.svg', mode: 'browser' },
      { name: 'Arduino Nano', chip: 'ATmega328P', icon: '/boards/arduino-nano.svg', mode: 'browser' },
      { name: 'Arduino Mega 2560', chip: 'ATmega2560', icon: '/boards/arduino-mega.svg', mode: 'browser' },
      { name: 'ATtiny85', chip: 'AVR Core', customIcon: <BoardATtiny85 />, mode: 'browser' },
    ]
  },
  {
    id: 'rp2040',
    name: 'ARM Cortex-M0+',
    engine: 'rp2040js',
    color: '#38bdf8', /* Sky Blue */
    boards: [
      { name: 'Pi Pico', chip: 'RP2040', icon: '/boards/pi-pico.svg', mode: 'hybrid' },
      { name: 'Pi Pico W', chip: 'RP2040 + WiFi', icon: '/boards/pi-pico-w.svg', mode: 'hybrid' },
    ]
  },
  {
    id: 'riscv',
    name: 'RISC-V Architecture',
    engine: 'RV32IMC',
    color: '#10b981', /* Emerald */
    boards: [
      { name: 'ESP32-C3', chip: 'RISC-V 160MHz', icon: '/boards/esp32-c3.svg', mode: 'hybrid' },
      { name: 'XIAO ESP32-C3', chip: 'RISC-V Compact', icon: '/boards/xiao-esp32-c3.svg', mode: 'hybrid' },
      { name: 'CH32V003', chip: 'RV32EC 48MHz', customIcon: <BoardCH32V003 />, mode: 'hybrid' },
    ]
  },
  {
    id: 'xtensa',
    name: 'Xtensa Architecture',
    engine: 'QEMU',
    color: '#f59e0b', /* Safety Orange */
    boards: [
      { name: 'ESP32 DevKit', chip: 'LX6 Dual-Core', icon: '/boards/esp32-devkit-c-v4.svg', mode: 'hybrid' },
      { name: 'ESP32-S3', chip: 'LX7 Dual-Core', icon: '/boards/esp32-s3.svg', mode: 'hybrid' },
      { name: 'ESP32-CAM', chip: 'LX6 + Camera', icon: '/boards/esp32-cam.svg', mode: 'hybrid' },
    ]
  },
  {
    id: 'linux',
    name: 'Linux Systems',
    engine: 'QEMU Full',
    color: '#71717a', /* Deep Slate */
    boards: [
      { name: 'Raspberry Pi 3', chip: 'Cortex-A53', icon: 'boards/Raspberry_Pi_3.svg', mode: 'backend' },
    ]
  }
];

const features = [
  { 
    title: '5 Emulation Engines', 
    desc: 'AVR8, RP2040, RISC-V (ESP32-C3), Xtensa (QEMU), and ARM Cortex-A53 (Linux).',
    icon: <IcoZap />
  },
  { 
    title: '48+ Visual Components', 
    desc: 'LEDs, LCDs, ILI9341 TFT displays, servos, buzzers, and ultrasonic sensors.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
    )
  },
  { 
    title: 'Monaco Editor', 
    desc: 'VS Code-grade C++ editor with syntax highlighting, autocomplete, and multi-file support.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    )
  },
  { 
    title: 'Local Compiler', 
    desc: 'Compile and flash sketches locally in seconds. No cloud dependency, 100% offline.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22V12M12 12l4 4M12 12l-4 4M4 7V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3" />
      </svg>
    )
  },
  { 
    title: 'Serial Monitor', 
    desc: 'Real-time TX/RX with auto baud-rate detection and message history.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      </svg>
    )
  },
  { 
    title: 'Library Manager', 
    desc: 'Access the full Arduino library index directly inside the editor.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20M4 19.5V3a2.5 2.5 0 0 1 2.5-2.5H20" />
      </svg>
    )
  }
];

/* ── Code Snippets Data ────────────────────────────── */
const CODE_SNIPPETS = [
  {
    filename: 'blink.ino',
    board: 'Arduino Uno',
    code: `void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
}`
  },
  {
    filename: 'serial_echo.ino',
    board: 'Arduino Mega',
    code: `void setup() {
  Serial.begin(115200);
  Serial.println("System Ready");
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    Serial.print("Received: ");
    Serial.println(c);
  }
}`
  },
  {
    filename: 'dht22_sensor.ino',
    board: 'ESP32 DevKit',
    code: `void setup() {
  dht.begin();
}

void loop() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  
  if (isnan(h) || isnan(t)) {
    return;
  }
  delay(2000);
}`
  },
  {
    filename: 'wifi_scanner.ino',
    board: 'ESP32-C3',
    code: `void setup() {
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
}

void loop() {
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; ++i) {
    Serial.println(WiFi.SSID(i));
  }
  delay(5000);
}`
  }
];

/* ── Interactive Code Component ─────────────────────── */
const InteractiveCode: React.FC = () => {
  const [snippetIndex, setSnippetIndex] = useState(0);
  const [displayText, setDisplayText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [typingStatus, setTypingStatus] = useState<'typing' | 'waiting' | 'compiling'>('typing');
  
  const currentSnippet = CODE_SNIPPETS[snippetIndex];
  const fullText = currentSnippet.code;
  
  useEffect(() => {
    let timer: NodeJS.Timeout;
    
    if (typingStatus === 'compiling') {
      timer = setTimeout(() => {
        setTypingStatus('typing');
        setSnippetIndex((prev) => (prev + 1) % CODE_SNIPPETS.length);
        setDisplayText('');
      }, 2000);
      return () => clearTimeout(timer);
    }

    if (typingStatus === 'waiting') {
      timer = setTimeout(() => {
        setIsDeleting(true);
        setTypingStatus('typing');
      }, 3000);
      return () => clearTimeout(timer);
    }

    const typeSpeed = isDeleting ? 30 : 50;
    
    timer = setTimeout(() => {
      if (!isDeleting) {
        setDisplayText(fullText.substring(0, displayText.length + 1));
        if (displayText.length + 1 === fullText.length) {
          setTypingStatus('waiting');
        }
      } else {
        setDisplayText(fullText.substring(0, displayText.length - 1));
        if (displayText.length === 0) {
          setIsDeleting(false);
          setTypingStatus('compiling');
        }
      }
    }, typeSpeed);

    return () => clearTimeout(timer);
  }, [displayText, isDeleting, typingStatus, fullText]);

  return (
    <div className="visual-window">
      <div className="window-header">
        <div className="window-controls"><span /><span /><span /></div>
        <div className="window-title">{currentSnippet.filename}</div>
      </div>
      <div className="window-body">
        <div className="code-snippet">
          {displayText.split('\n').map((line, i) => (
            <div key={i} className="line">
              {line.split(/(\s+)/).map((part, j) => {
                if (['void', 'int', 'float', 'if', 'for', 'return'].includes(part.trim())) return <span key={j} className="kw">{part}</span>;
                if (['setup', 'loop', 'pinMode', 'digitalWrite', 'delay', 'begin', 'println', 'print', 'available', 'read', 'readHumidity', 'readTemperature', 'isnan', 'mode', 'disconnect', 'scanNetworks', 'SSID'].includes(part.trim())) return <span key={j} className="fn">{part}</span>;
                if (['OUTPUT', 'HIGH', 'LOW', 'WIFI_STA'].includes(part.trim())) return <span key={j} className="const">{part}</span>;
                if (/^\d+$/.test(part.trim())) return <span key={j} className="num">{part}</span>;
                if (part.startsWith('"')) return <span key={j} style={{ color: '#f1fa8c' }}>{part}</span>;
                return part;
              })}
              {i === displayText.split('\n').length - 1 && <span className="cursor">|</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="window-footer">
        <div className="status-chip">
          {typingStatus === 'compiling' ? (
            <>
              <span className="spinner" />
              Compiling for {currentSnippet.board}...
            </>
          ) : (
            <>
              <span className="pulse-green" />
              {currentSnippet.board} · Ready
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export const LandingPage: React.FC = () => {
  useSEO(getSeoMeta('/')!);

  return (
    <div className="landing">
      <AppHeader />

      <main className="landing-main">
        {/* Hero Section */}
        <section className="hero-section">
          <div className="hero-glow-1" />
          <div className="hero-container">
            <div className="hero-badge">
              <span className="badge-dot" />
              IntelliBoard v1 Professional
            </div>
            <h1 className="hero-heading">
              Engineer Your Idea.
              <br />
              <span className="gradient-text">Zero Hardware.</span>
            </h1>
            <p className="hero-description">
              The world's most advanced hardware emulator. 
              Real-time simulation, local compilation, and multi-architecture support 
              for Arduino, ESP32, and beyond.
            </p>
            <div className="hero-actions">
              <Link to="/editor" className="btn-primary" onClick={() => trackClickCTA('landing', '/editor')}>
                Launch Simulator
                <IcoArrowRight />
              </Link>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="btn-secondary" onClick={trackVisitGitHub}>
                <IcoGitHub />
                GitHub
              </a>
            </div>
          </div>

          <div className="hero-visual">
            <InteractiveCode />
          </div>
        </section>

        {/* Board Selection Section */}
        <section className="boards-section">
          <div className="section-header">
            <span className="section-label">Supported Hardware</span>
            <h2 className="section-title">Every architecture. One tool.</h2>
            <p className="section-desc">19+ boards across 5 CPU architectures. All running locally, no cloud needed.</p>
          </div>

          <div className="board-groups-container">
            {boardGroups.map(group => (
              <div key={group.id} className="board-group">
                <div className="group-meta">
                  <span className="group-engine" style={{ backgroundColor: group.color }}>{group.engine}</span>
                  <h3 className="group-name">{group.name}</h3>
                </div>
                <div className="boards-grid">
                  {group.boards.map(board => (
                    <div key={board.name} className="board-card">
                      <div className="board-visual">
                        {board.customIcon ? board.customIcon : <img src={board.icon} alt={board.name} />}
                      </div>
                      <div className="board-info">
                        <div className="board-name-row">
                          <h4>{board.name}</h4>
                          {board.mode === 'browser' && <span className="mode-badge browser" title="Full Browser Support">Browser</span>}
                          {board.mode === 'hybrid' && <span className="mode-badge hybrid" title="Browser Simulation + Server Compile">Hybrid</span>}
                          {board.mode === 'backend' && <span className="mode-badge backend" title="Full Server Compilation & Simulation">Server</span>}
                        </div>
                        <span>{board.chip}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Enhanced Features Section */}
        <section className="features-section">
          <div className="section-header centered">
            <span className="section-label">Features</span>
            <h2 className="section-title">Everything you need.</h2>
          </div>
          <div className="features-grid">
            {features.map((f, i) => (
              <div key={i} className="feature-item">
                <div className="feature-icon-box">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};
