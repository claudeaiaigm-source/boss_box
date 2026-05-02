import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import BossBox from './bossbox.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BossBox />
  </React.StrictMode>
);

// Remove splash screen after React renders
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.style.transition = 'opacity 0.4s';
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 400);
    }
  });
});
