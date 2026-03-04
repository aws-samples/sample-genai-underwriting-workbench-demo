import { Authenticator, Button, Divider, Flex } from '@aws-amplify/ui-react';
import { signInWithRedirect } from 'aws-amplify/auth';
import '@aws-amplify/ui-react/styles.css';

const Login = () => {
  return (
    <Authenticator
      hideSignUp={true}
      variation="modal"
      components={{
        SignIn: {
          Header: () => {
            return (
              <Flex direction="column" padding="2rem 2rem 0">
                <Button onClick={() => signInWithRedirect()} gap="1rem" isFullWidth>
                  Sign in with Midway
                </Button>
                <Divider label="or" size="small" />
              </Flex>
            );
          },
        },
      }}
    />
  );
};

export default Login;
