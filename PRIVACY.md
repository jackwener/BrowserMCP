# Privacy Policy for BrowserMCP

Last updated: September 20, 2026

BrowserMCP and its BrowserMCP Connector extension provide a local browser runtime for MCP-compatible agents. It lets an agent operate the user's existing Chrome session after the user has installed and enabled the extension and started the local BrowserMCP host.

## Information handled

Depending on the browser task and the capabilities used, BrowserMCP may handle:

- browser tab metadata, including URLs, titles, navigation state, and tab groups;
- website content that the user asks the agent to inspect or operate on, including text, links, images, and page state;
- user activity needed to perform an explicitly requested task, such as clicks, typing, scrolling, and network requests observed for debugging or site capability discovery; and
- session cookies and related authentication data when a user-authorized site operation needs the existing logged-in browser session.

BrowserMCP does not ask for, collect, or store the user's passwords. Users should not instruct an agent to expose sensitive information unnecessarily.

## How information is used

The information above is used only to provide the extension's single purpose: allowing the local MCP runtime to inspect and operate the user's authorized Chrome session. It is not used for advertising, profiling, credit decisions, or unrelated tracking.

## Where information goes

The extension communicates with the BrowserMCP native host on the user's own computer through Chrome Native Messaging. The project does not operate a hosted service that receives browser content, cookies, or browsing history. A site may receive requests made to that site as part of the user's requested browser workflow, and Chrome may process data under its own policies.

## Storage and retention

Session state and extension settings are kept in Chrome's local or session storage as needed for the runtime. Browser data handled during a task is intended to be transient and is not uploaded to a BrowserMCP server. Users can stop a session, disable or remove the extension, or clear Chrome's extension data at any time.

## Sharing and sale

The project does not sell user data or transfer it to third parties for purposes unrelated to the extension's single purpose. Data may be processed by the user's browser, the local native host, and websites the user chooses to visit during a task.

## Security

The extension is designed to keep browser credentials in the user's Chrome profile and to communicate with a local native host. Because browser automation can access information available to the signed-in browser session, users should review agent actions and only use trusted MCP clients and site capabilities.

## Changes and contact

This policy may be updated as BrowserMCP changes. The current version is published in the project repository. Questions or privacy requests can be submitted at <https://github.com/jackwener/browsermcp/issues>.
