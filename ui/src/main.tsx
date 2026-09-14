import React from 'react';
import { createRoot } from 'react-dom/client';
import 'diff2html/bundles/css/diff2html.min.css';
import './styles.css';
import { App } from './App.js';
import { startEventStream } from './lib/eventStream.js';

startEventStream();
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
