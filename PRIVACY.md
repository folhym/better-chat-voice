# Privacy

This extension reads the ChatGPT assistant reply whose Irodori button you click. If you turn on automatic reading (off by default), it also sends newly completed assistant replies to your configured Irodori-TTS Server URL. It plays the returned audio in the browser.

The server URL, selected voice ID, speech rate, and automatic reading setting are stored in Chrome local storage. No API keys, OpenAI API calls, ElevenLabs calls, analytics, or telemetry are used by this extension.

Generated audio is kept only in the current page's memory for replay. It is released when regenerated, when its answer is removed, or when the page closes. The extension does not save audio files or use persistent audio storage.

If you configure a server on another host, Chrome asks for access to that host. Reply text is then transmitted to that configured host when you click its read button or when automatic reading is on and a new reply completes.
