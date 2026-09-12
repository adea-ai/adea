/**
 * GitHub organization → the organization's primary web domain. Used to
 * resolve real provider favicons for plugins whose homepage points at a
 * repository instead of a website (e.g. `github.com/adobe/skills` →
 * `www.adobe.com`). Companies only: never map marketplace repositories
 * (like `anthropics/claude-plugins-public`) — their favicon is not the
 * plugin brand's logo.
 *
 * Extend when new plugin sources appear; see `pluginIconUrl`.
 */
export const PLUGIN_ORG_DOMAINS: Readonly<Record<string, string>> = {
  AmazonCosmosDB: 'azure.microsoft.com',
  AzureCosmosDB: 'azure.microsoft.com',
  'BrainBlend-AI': 'eigenwise.github.io',
  CrowdStrike: 'www.crowdstrike.com',
  'LSEG-API-Samples': 'www.lseg.com',
  PagerDuty: 'www.pagerduty.com',
  SAP: 'www.sap.com',
  'SAP-samples': 'www.sap.com',
  SalesforceAIResearch: 'www.salesforce.com',
  TheQtCompanyRnD: 'www.qt.io',
  UI5: 'www.sap.com',
  adobe: 'www.adobe.com',
  amplitude: 'amplitude.com',
  atlassian: 'www.atlassian.com',
  auth0: 'auth0.com',
  aws: 'aws.amazon.com',
  awslabs: 'aws.amazon.com',
  b12io: 'b12.io',
  box: 'www.box.com',
  circlebackai: 'circleback.ai',
  cloudflare: 'www.cloudflare.com',
  coderabbitai: 'www.coderabbit.ai',
  coursera: 'www.coursera.org',
  daloopa: 'www.daloopa.com',
  expo: 'expo.dev',
  fastly: 'www.fastly.com',
  'gemini-cli-extensions': 'cloud.google.com',
  getsentry: 'sentry.io',
  honeycombio: 'www.honeycomb.io',
  intercom: 'www.intercom.com',
  makenotion: 'www.notion.com',
  microsoft: 'www.microsoft.com',
  microsoftdocs: 'learn.microsoft.com',
  netlify: 'www.netlify.com',
  oracle: 'www.oracle.com',
  'pinecone-io': 'www.pinecone.io',
  pydantic: 'pydantic.dev',
  spotify: 'spotify.com',
  stripe: 'stripe.com',
  taosdata: 'tdengine.com',
  vercel: 'vercel.com',
  zapier: 'zapier.com',
  zscaler: 'www.zscaler.com',
}
