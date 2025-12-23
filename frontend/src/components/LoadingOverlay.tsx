import '../styles/LoadingOverlay.css';

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
}

export function LoadingOverlay({ isVisible, message = 'Loading...' }: LoadingOverlayProps) {
  if (!isVisible) {
    return null;
  }

  return (
    <div className="loading-overlay" data-testid="loading-overlay">
      <div className="loading-spinner-container">
        <div className="loading-spinner" />
        <p className="loading-message">{message}</p>
      </div>
    </div>
  );
}

