import React, { useState, useEffect, useRef } from 'react';

const cellSize = 20;

function getColumnLabel(index) {
  let label = '';
  index++;
  while (index > 0) {
    let rem = (index - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    index = Math.floor((index - 1) / 26);
  }
  return label;
}

const PixelLogo = () => {
  const pattern = [
    [1,1,1,1,1],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,0,0,0,0],
    [1,1,1,1,1],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 10px)', gridTemplateRows: 'repeat(5, 10px)', gap: 0, marginBottom: '20px' }}>
      {pattern.flat().map((cell, i) => (
        <div key={i} style={{ width: 10, height: 10, background: cell ? '#000000' : 'transparent' }} />
      ))}
    </div>
  );
};

const projects = [
  { name: 'Apex Financial Terminal', year: '2023', sector: 'Fintech' },
  { name: 'Mono-Space Gallery', year: '2023', sector: 'Culture' },
  { name: 'Structure & Void', year: '2022', sector: 'Architecture' },
  { name: 'Grid Systems Intl.', year: '2022', sector: 'E-Commerce' },
  { name: 'Null_Pointer Exception', year: '2021', sector: 'Experimental' },
];

const navItems = [
  { label: 'Index [A]', section: 'index' },
  { label: 'Projects [B]', section: 'projects' },
  { label: 'Agency [C]', section: 'agency' },
  { label: 'Contact [D]', section: 'contact' },
];

const App = () => {
  const [coords, setCoords] = useState({ x: 0, y: 0, label: 'X: A | Y: 1' });
  const [cursorVisible, setCursorVisible] = useState(false);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [rulerXItems, setRulerXItems] = useState([]);
  const [rulerYItems, setRulerYItems] = useState([]);
  const [pixelClusters, setPixelClusters] = useState([]);
  const [activeSection, setActiveSection] = useState('index');
  const [hoveredProject, setHoveredProject] = useState(null);
  const [hoveredNav, setHoveredNav] = useState(null);

  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; cursor: crosshair; }
      body { margin: 0; padding: 0; overflow-x: hidden; }
      .content-card::after {
        content: "";
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background-image:
          linear-gradient(to right, rgba(0,0,0,0.03) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(0,0,0,0.03) 1px, transparent 1px);
        background-size: 20px 20px;
        pointer-events: none;
      }
    `;
    document.head.appendChild(style);
    return () => document.head.removeChild(style);
  }, []);

  const generateRulers = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const cols = Math.ceil(width / cellSize);
    const rows = Math.ceil(height / cellSize);
    setRulerXItems(Array.from({ length: cols }, (_, i) => getColumnLabel(i)));
    setRulerYItems(Array.from({ length: rows }, (_, i) => i + 1));
  };

  const generatePixelArt = () => {
    const clusters = [];
    const strokes = 8;
    for (let s = 0; s < strokes; s++) {
      let startX = Math.floor(Math.random() * (window.innerWidth / cellSize));
      let startY = Math.floor(Math.random() * (window.innerHeight / cellSize));
      let length = 20 + Math.floor(Math.random() * 50);
      let dx = Math.random() > 0.5 ? 1 : -1;
      let dy = Math.random() > 0.5 ? 1 : 0;
      for (let i = 0; i < length; i++) {
        let thickness = Math.floor(Math.random() * 3) + 1;
        for (let t = 0; t < thickness; t++) {
          if (Math.random() > 0.2) {
            clusters.push({
              id: `${s}-${i}-${t}`,
              left: (startX + i * dx) * cellSize,
              top: (startY + i * dy + t) * cellSize,
            });
          }
        }
      }
    }
    setPixelClusters(clusters);
  };

  useEffect(() => {
    generateRulers();
    generatePixelArt();
    window.addEventListener('resize', generateRulers);
    return () => window.removeEventListener('resize', generateRulers);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      const x = Math.floor((e.clientX - 30) / cellSize);
      const y = Math.floor((e.clientY - 20) / cellSize);
      const visualX = x * cellSize + 30;
      const visualY = y * cellSize + 20;
      if (e.clientX > 30 && e.clientY > 20) {
        setCursorVisible(true);
        setCursorPos({ x: visualX, y: visualY });
        setCoords({ label: `X: ${getColumnLabel(x)} | Y: ${y + 1}` });
      } else {
        setCursorVisible(false);
      }
    };
    document.addEventListener('mousemove', handleMouseMove);
    return () => document.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const cardStyle = {
    background: '#ffffff',
    border: '1px solid #dcdcdc',
    padding: '20px',
    position: 'relative',
    marginBottom: '60px',
    boxShadow: '10px 10px 0px rgba(0,0,0,0.05)',
  };

  return (
    <div style={{ margin: 0, padding: 0, backgroundColor: '#f0f0f0', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", color: '#000000', overflowX: 'hidden', width: '100vw', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* Corner piece */}
      <div style={{ position: 'fixed', top: 0, left: 0, width: 30, height: 20, background: '#000000', zIndex: 101 }} />

      {/* Ruler X */}
      <div style={{ position: 'fixed', top: 0, left: 30, right: 0, height: 20, background: '#e8e8e8', borderBottom: '1px solid #000000', display: 'flex', overflow: 'hidden', zIndex: 100, fontFamily: "'Courier New', Courier, monospace", fontSize: 10, lineHeight: '20px', color: '#666', userSelect: 'none' }}>
        {rulerXItems.map((label, i) => (
          <span key={i} style={{ display: 'inline-block', width: cellSize, textAlign: 'center', borderRight: '1px solid #ccc', flexShrink: 0 }}>{label}</span>
        ))}
      </div>

      {/* Ruler Y */}
      <div style={{ position: 'fixed', top: 20, left: 0, bottom: 0, width: 30, background: '#e8e8e8', borderRight: '1px solid #000000', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 100, fontFamily: "'Courier New', Courier, monospace", fontSize: 10, color: '#666', userSelect: 'none' }}>
        {rulerYItems.map((label, i) => (
          <span key={i} style={{ display: 'block', height: cellSize, lineHeight: `${cellSize}px`, textAlign: 'center', borderBottom: '1px solid #ccc', flexShrink: 0 }}>{label}</span>
        ))}
      </div>

      {/* Grid layer */}
      <div style={{ position: 'fixed', top: 20, left: 30, width: 'calc(100% - 30px)', height: 'calc(100% - 20px)', backgroundImage: 'linear-gradient(to right, #dcdcdc 1px, transparent 1px), linear-gradient(to bottom, #dcdcdc 1px, transparent 1px)', backgroundSize: `${cellSize}px ${cellSize}px`, zIndex: 0, pointerEvents: 'none' }} />

      {/* Cursor box */}
      {cursorVisible && (
        <div style={{ position: 'fixed', width: cellSize, height: cellSize, border: '1px solid #000000', background: 'rgba(0,0,0,0.1)', pointerEvents: 'none', zIndex: 50, transform: `translate(${cursorPos.x}px, ${cursorPos.y}px)`, top: 0, left: 0 }} />
      )}

      {/* Coordinates display */}
      <div style={{ position: 'fixed', bottom: 0, right: 0, background: '#000000', color: '#ffffff', fontFamily: "'Courier New', Courier, monospace", fontSize: 12, padding: '5px 10px', zIndex: 200 }}>
        {coords.label}
      </div>

      {/* Nav */}
      <nav style={{ position: 'fixed', top: 40, right: 40, background: '#ffffff', border: '1px solid #000000', display: 'flex', flexDirection: 'column', zIndex: 999 }}>
        {navItems.map((item) => (
          <a
            key={item.section}
            href="#"
            onClick={(e) => { e.preventDefault(); setActiveSection(item.section); }}
            onMouseEnter={() => setHoveredNav(item.section)}
            onMouseLeave={() => setHoveredNav(null)}
            style={{
              display: 'block',
              height: cellSize,
              lineHeight: `${cellSize}px`,
              padding: '0 10px',
              borderBottom: item.section !== 'contact' ? '1px solid #dcdcdc' : 'none',
              fontSize: 12,
              textTransform: 'uppercase',
              textDecoration: 'none',
              color: hoveredNav === item.section ? '#ffffff' : '#000000',
              background: hoveredNav === item.section ? '#000000' : 'transparent',
              transition: 'all 0.1s',
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* Pixel art container */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5, overflow: 'hidden' }}>
        {pixelClusters.map((cluster) => (
          <div key={cluster.id} style={{ position: 'absolute', background: '#000000', width: cellSize, height: cellSize, left: cluster.left, top: cluster.top }} />
        ))}
      </div>

      {/* Main stage */}
      <div style={{ position: 'relative', marginTop: 20, marginLeft: 30, width: 'calc(100% - 30px)', minHeight: '100vh', zIndex: 10, padding: `${cellSize * 2}px` }}>

        {/* Index section */}
        {activeSection === 'index' && (
          <>
            {/* Hero card */}
            <div className="content-card" style={{ ...cardStyle, maxWidth: 600, marginLeft: cellSize * 4, marginTop: cellSize * 4 }}>
              <PixelLogo />
              <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>SYS.OP.2024 // V.1.0.4</span>
              <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Coordinate Studio</h1>
              <h2 style={{ fontSize: 32, lineHeight: `${cellSize * 2}px`, margin: `0 0 ${cellSize}px 0`, fontWeight: 400, letterSpacing: '-0.5px', maxWidth: 800 }}>We construct digital environments with rigorous precision and structural integrity.</h2>
              <br />
              <div style={{ display: 'flex', gap: 20 }}>
                <div>
                  <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>LOCATION</span>
                  <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, maxWidth: '45ch' }}>New York, NY<br />10013</p>
                </div>
                <div>
                  <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>STATUS</span>
                  <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, maxWidth: '45ch' }}>Accepting New<br />Commissions</p>
                </div>
              </div>
            </div>

            {/* Projects card */}
            <div className="content-card" style={{ ...cardStyle, marginLeft: cellSize * 12, width: `calc(100% - ${cellSize * 16}px)` }}>
              <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Selected Architecture</h1>
              <div style={{ borderTop: '1px solid #000000', marginTop: cellSize }}>
                {/* Header row */}
                <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', borderBottom: '1px solid #dcdcdc' }}>
                  {['Client Name', 'Year', 'Sector'].map((h) => (
                    <div key={h} style={{ padding: 10, fontSize: 11, borderRight: h !== 'Sector' ? '1px solid #dcdcdc' : 'none', display: 'flex', alignItems: 'center', fontWeight: 'bold', textTransform: 'uppercase', background: '#eee' }}>{h}</div>
                  ))}
                </div>
                {projects.map((p, i) => (
                  <div
                    key={i}
                    onMouseEnter={() => setHoveredProject(i)}
                    onMouseLeave={() => setHoveredProject(null)}
                    style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', borderBottom: '1px solid #dcdcdc', background: hoveredProject === i ? '#f7f7f7' : 'transparent', transition: 'background 0.1s' }}
                  >
                    <div style={{ padding: 10, fontSize: 13, borderRight: '1px solid #dcdcdc', display: 'flex', alignItems: 'center' }}>{p.name}</div>
                    <div style={{ padding: 10, fontSize: 13, borderRight: '1px solid #dcdcdc', display: 'flex', alignItems: 'center', fontFamily: "'Courier New', Courier, monospace" }}>{p.year}</div>
                    <div style={{ padding: 10, fontSize: 13, display: 'flex', alignItems: 'center' }}>{p.sector}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Methodology card */}
            <div className="content-card" style={{ ...cardStyle, maxWidth: 400, marginLeft: cellSize * 2 }}>
              <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Methodology</h1>
              <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, maxWidth: '45ch' }}>Our work is not decorated. It is engineered. We believe the web is a grid, not a canvas. By exposing the underlying logic of the browser, we create interfaces that feel honest, raw, and utilitarian.</p>
              <br />
              <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, fontFamily: "'Courier New', Courier, monospace" }}>-&gt; READ FULL PROTOCOL</p>
            </div>
          </>
        )}

        {/* Projects section */}
        {activeSection === 'projects' && (
          <div className="content-card" style={{ ...cardStyle, marginLeft: cellSize * 4, marginTop: cellSize * 4 }}>
            <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>SYS.PROJECTS // ALL WORK</span>
            <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Project Archive</h1>
            <h2 style={{ fontSize: 32, lineHeight: `${cellSize * 2}px`, margin: `0 0 ${cellSize}px 0`, fontWeight: 400, letterSpacing: '-0.5px', maxWidth: 800 }}>A complete record of constructed digital environments.</h2>
            <div style={{ borderTop: '1px solid #000000', marginTop: cellSize }}>
              <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', borderBottom: '1px solid #dcdcdc' }}>
                {['Client Name', 'Year', 'Sector'].map((h) => (
                  <div key={h} style={{ padding: 10, fontSize: 11, borderRight: h !== 'Sector' ? '1px solid #dcdcdc' : 'none', display: 'flex', alignItems: 'center', fontWeight: 'bold', textTransform: 'uppercase', background: '#eee' }}>{h}</div>
                ))}
              </div>
              {projects.map((p, i) => (
                <div
                  key={i}
                  onMouseEnter={() => setHoveredProject(i)}
                  onMouseLeave={() => setHoveredProject(null)}
                  style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', borderBottom: '1px solid #dcdcdc', background: hoveredProject === i ? '#f7f7f7' : 'transparent', transition: 'background 0.1s' }}
                >
                  <div style={{ padding: 10, fontSize: 13, borderRight: '1px solid #dcdcdc', display: 'flex', alignItems: 'center' }}>{p.name}</div>
                  <div style={{ padding: 10, fontSize: 13, borderRight: '1px solid #dcdcdc', display: 'flex', alignItems: 'center', fontFamily: "'Courier New', Courier, monospace" }}>{p.year}</div>
                  <div style={{ padding: 10, fontSize: 13, display: 'flex', alignItems: 'center' }}>{p.sector}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Agency section */}
        {activeSection === 'agency' && (
          <div className="content-card" style={{ ...cardStyle, maxWidth: 700, marginLeft: cellSize * 4, marginTop: cellSize * 4 }}>
            <PixelLogo />
            <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>SYS.AGENCY // ABOUT</span>
            <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>About The Studio</h1>
            <h2 style={{ fontSize: 32, lineHeight: `${cellSize * 2}px`, margin: `0 0 ${cellSize}px 0`, fontWeight: 400, letterSpacing: '-0.5px', maxWidth: 800 }}>Founded on the principle that digital space deserves the same rigor as physical architecture.</h2>
            <br />
            <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, maxWidth: '55ch' }}>Coordinate Studio is a digital design and engineering practice. We build precise, systematic, and undecorated digital environments that function as true instruments. Our approach treats the browser as a measurement tool, not a blank canvas.</p>
            <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, maxWidth: '55ch' }}>Every pixel is intentional. Every grid unit is accounted for. Every system is documented.</p>
            <br />
            <div style={{ display: 'flex', gap: 40 }}>
              {[{ label: 'FOUNDED', value: '2018' }, { label: 'TEAM', value: '7 Members' }, { label: 'PROJECTS', value: '40+' }].map((item) => (
                <div key={item.label}>
                  <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>{item.label}</span>
                  <p style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: 0, fontWeight: 700 }}>{item.value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Contact section */}
        {activeSection === 'contact' && (
          <div className="content-card" style={{ ...cardStyle, maxWidth: 500, marginLeft: cellSize * 4, marginTop: cellSize * 4 }}>
            <span style={{ fontFamily: "'Courier New', Courier, monospace", fontSize: 11, color: '#666', marginBottom: cellSize, display: 'block' }}>SYS.CONTACT // INITIATE</span>
            <h1 style={{ fontSize: 14, lineHeight: `${cellSize}px`, margin: `0 0 ${cellSize}px 0`, textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Open A Commission</h1>
            <h2 style={{ fontSize: 28, lineHeight: `${cellSize * 2}px`, margin: `0 0 ${cellSize}px 0`, fontWeight: 400, letterSpacing: '-0.5px' }}>Ready to construct something precise?</h2>
            <br />
            <ContactForm cellSize={cellSize} />
          </div>
        )}

      </div>
    </div>
  );
};

const ContactForm = ({ cellSize }) => {
  const [form, setForm] = useState({ name: '', email: '', message: '' });
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});

  const inputStyle = {
    width: '100%',
    border: '1px solid #000000',
    padding: '8px 10px',
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontSize: 13,
    background: '#f0f0f0',
    outline: 'none',
    marginBottom: 10,
    display: 'block',
  };

  const labelStyle = {
    fontFamily: "'Courier New', Courier, monospace",
    fontSize: 11,
    color: '#666',
    display: 'block',
    marginBottom: 4,
    textTransform: 'uppercase',
  };

  const validate = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Required';
    if (!form.email.trim() || !form.email.includes('@')) errs.email = 'Valid email required';
    if (!form.message.trim()) errs.message = 'Required';
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div style={{ padding: 20, border: '1px solid #000', background: '#fff', fontFamily: "'Courier New', Courier, monospace", fontSize: 13 }}>
        <p style={{ margin: 0, fontWeight: 700 }}>TRANSMISSION RECEIVED</p>
        <p style={{ margin: '10px 0 0 0', color: '#666' }}>We will respond within 48 grid units.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label style={labelStyle}>Name</label>
        <input
          style={{ ...inputStyle, borderColor: errors.name ? 'red' : '#000000' }}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Your name"
        />
        {errors.name && <span style={{ fontSize: 11, color: 'red', fontFamily: "'Courier New', Courier, monospace" }}>{errors.name}</span>}
      </div>
      <div>
        <label style={labelStyle}>Email</label>
        <input
          style={{ ...inputStyle, borderColor: errors.email ? 'red' : '#000000' }}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="your@email.com"
        />
        {errors.email && <span style={{ fontSize: 11, color: 'red', fontFamily: "'Courier New', Courier, monospace" }}>{errors.email}</span>}
      </div>
      <div>
        <label style={labelStyle}>Message</label>
        <textarea
          style={{ ...inputStyle, height: 100, resize: 'vertical', borderColor: errors.message ? 'red' : '#000000' }}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          placeholder="Describe your project..."
        />
        {errors.message && <span style={{ fontSize: 11, color: 'red', fontFamily: "'Courier New', Courier, monospace" }}>{errors.message}</span>}
      </div>
      <button
        type="submit"
        style={{ marginTop: 10, border: '1px solid #000000', background: '#000000', color: '#ffffff', padding: '8px 20px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.5px', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", cursor: 'crosshair' }}
      >
        Transmit
      </button>
    </form>
  );
};

export default App;