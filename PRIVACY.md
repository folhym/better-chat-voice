# Privacy

This extension reads only the ChatGPT assistant reply whose Irodori button you click. It sends that reply to the Irodori-TTS Server URL you configured, then plays the returned audio in the browser.

The server URL, selected voice ID, and speech rate are stored in Chrome local storage. No API keys, OpenAI API calls, ElevenLabs calls, analytics, or telemetry are used by this extension.

If you configure a server on another host, Chrome asks for access to that host. The reply text is then transmitted to that configured host when you click its read button.
