import React, { useState } from 'react';
import { signInWithGoogle } from '../lib/api';
import { Loader2, LogIn, AlertCircle } from 'lucide-react';
import Logo from './Logo';

const LoginPage = () => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleGoogleLogin = async () => {
        setLoading(true);
        setError('');
        try {
            await signInWithGoogle();
            // Note: The browser will redirect to Google here, so loading state stays true
        } catch (err) {
            setError(err.message || 'Failed to initialize Google Login');
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-backdrop" />
            <div className="login-card">
                <div className="login-logo" style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.5rem' }}>
                    <Logo height="80px" />
                </div>

                <div className="login-form">
                    {error && (
                        <div className="login-error">
                            <AlertCircle size={14} />
                            {error}
                        </div>
                    )}

                    <button
                        type="button"
                        className="login-btn google-login-btn"
                        onClick={handleGoogleLogin}
                        disabled={loading}
                    >
                        {loading ? (
                            <><Loader2 size={16} className="spin" /> Redirecting to Google...</>
                        ) : (
                            <>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginRight: '8px' }}>
                                    <path d="M22.56 12.25C22.56 11.47 22.49 10.74 22.36 10.04H12V14.22H17.92C17.67 15.57 16.89 16.71 15.75 17.47V20.2H19.32C21.41 18.28 22.56 15.52 22.56 12.25Z" fill="#4285F4" />
                                    <path d="M12 23C14.97 23 17.46 22.02 19.32 20.2L15.75 17.47C14.74 18.15 13.48 18.57 12 18.57C9.13 18.57 6.66 16.63 5.76 14.04H2.08V16.89C3.91 20.53 7.66 23 12 23Z" fill="#34A853" />
                                    <path d="M5.76 14.04C5.53 13.37 5.4 12.65 5.4 11.91C5.4 11.17 5.53 10.45 5.76 9.78V6.93H2.08C1.3 8.49 0.86 10.15 0.86 11.91C0.86 13.67 1.3 15.33 2.08 16.89L5.76 14.04Z" fill="#FBBC05" />
                                    <path d="M12 5.25C13.61 5.25 15.06 5.8 16.2 6.89L19.4 3.69C17.46 1.88 14.97 0.820007 12 0.820007C7.66 0.820007 3.91 3.29001 2.08 6.93L5.76 9.78C6.66 7.19 9.13 5.25 12 5.25Z" fill="#EA4335" />
                                </svg>
                                Sign in with Google
                            </>
                        )}
                    </button>

                    <p className="login-hint">
                        Securely authenticate with your Razorpay account
                    </p>
                </div>
            </div>
        </div>
    );
};

export default LoginPage;
