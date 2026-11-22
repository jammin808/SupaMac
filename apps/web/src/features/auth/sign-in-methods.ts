import {
  ENABLE_APPLE_SIGN_IN,
  ENABLE_DOMAIN_SSO_SIGN_IN,
  ENABLE_GOOGLE_SIGN_IN,
  ENABLE_PASSWORD_SIGN_IN,
} from '@core/constant/featureFlags';
import { SELF_HOSTED } from '@core/constant/servers';

/** The ways to sign in besides the emailed code, which every build offers. */
type SignInMethods = {
  google: boolean;
  apple: boolean;
  /** An account that signs in with a password instead of a code. */
  password: boolean;
  /** An address sent on to its organization's identity provider. */
  domainSso: boolean;
};

/**
 * Which of those this build offers. A self-hosted instance signs people in
 * with an emailed code alone until its owner sets a method up and builds with
 * that method's flag; every other build offers them all. Continue with
 * Microsoft has a flag of its own in every build (`enableMicrosoftSignup`).
 */
export function signInMethods(): SignInMethods {
  return {
    google: !SELF_HOSTED || ENABLE_GOOGLE_SIGN_IN,
    apple: !SELF_HOSTED || ENABLE_APPLE_SIGN_IN,
    password: !SELF_HOSTED || ENABLE_PASSWORD_SIGN_IN,
    domainSso: !SELF_HOSTED || ENABLE_DOMAIN_SSO_SIGN_IN,
  };
}
