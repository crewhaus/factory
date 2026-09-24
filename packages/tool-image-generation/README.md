# @crewhaus/tool-image-generation

`ImageGenerate`: an image from a text prompt, through a remote API.

```yaml
tools:
  - imageGenerate

tool_config:
  imageGenerate:
    provider: openai        # openai (default when OPENAI_API_KEY is set) or mock
    model: gpt-image-1      # optional; dall-e-3 by default
```

The key is read from `OPENAI_API_KEY`. It is never written in the spec.

## Where the key is sent

By default the key goes to `https://api.openai.com/v1` and nowhere else.

`openaiBaseUrl` points the tool at a proxy or Azure OpenAI instead. Because
the key goes wherever that URL points, a spec cannot set it alone — a spec can
come from a template or a pull request. The operator approves the endpoint by
setting `OPENAI_BASE_URL` to the same origin in the environment the harness
starts in:

```yaml
tool_config:
  imageGenerate:
    openaiBaseUrl: https://llm-proxy.internal.example/v1
```

```sh
OPENAI_BASE_URL=https://llm-proxy.internal.example/v1 bun agent.ts
```

- Anything but `https://api.openai.com` without that approval is refused at
  boot and on every call, before a request is made.
- Plain `http` is refused, because the key would cross the network
  unencrypted. The one exception is a proxy on loopback (`http://127.0.0.1`,
  `http://localhost`), and only with the same approval.
- A URL with `user:password@` in it is refused.

`provider: mock` needs no key and sends nothing; use it for offline tests.
