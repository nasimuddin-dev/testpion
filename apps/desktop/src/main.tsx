import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installErrorCapture } from './lib/error-capture';

installErrorCapture();
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import App from './App';
import { ViewBoundary } from './components/ViewBoundary';

// apply the stored theme before first paint to avoid a flash
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* the last line of defence: an error nothing else caught shows a calm page with Reload, never a blank window */}
    <ViewBoundary view="app" variant="app">
      <App />
    </ViewBoundary>
  </StrictMode>,
);
