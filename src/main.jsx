import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import '../styles.css';
import './react.css';
import './account.css';
import './account-settings.css';
import './saudi.css';
import './responsive.css';
import './upgrade-theme.css';

import './theme-system.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter><App /></BrowserRouter></React.StrictMode>);
