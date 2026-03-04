import { Amplify } from 'aws-amplify';

interface AuthConfig {
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  userPoolDomainUrl: string;
  callbackUrl: string;
  region: string;
}

async function loadConfig(): Promise<AuthConfig> {
  if (import.meta.env.DEV) {
    return {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
      identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID,
      userPoolDomainUrl: import.meta.env.VITE_USER_POOL_DOMAIN_URL,
      callbackUrl: import.meta.env.VITE_CALLBACK_URL || 'http://localhost:5173',
      region: import.meta.env.VITE_REGION || 'us-east-1',
    };
  }

  const response = await fetch('/config.json');
  return response.json();
}

export async function configureAuth(): Promise<void> {
  const config = await loadConfig();

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        identityPoolId: config.identityPoolId,
        loginWith: {
          oauth: {
            domain: config.userPoolDomainUrl.replace('https://', ''),
            scopes: ['openid', 'profile'],
            redirectSignIn: [config.callbackUrl],
            redirectSignOut: [config.callbackUrl],
            responseType: 'code',
          },
        },
      },
    },
  });
}
