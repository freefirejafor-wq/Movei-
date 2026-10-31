import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Unregister any stale dev service workers that might intercept /api/* routes
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      if (registration.active?.scriptURL?.includes('dev-sw')) {
        registration.unregister();
      }
    }
  }).catch(() => {});
}

createRoot(document.getElementById('root')!).render(<App />);
