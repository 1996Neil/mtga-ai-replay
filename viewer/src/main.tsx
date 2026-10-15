import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './board.css';
import './replayControls.css';
import './p2-preview.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
