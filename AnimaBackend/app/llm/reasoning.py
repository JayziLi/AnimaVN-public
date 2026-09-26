"""Pull an inline <think>...</think> block out of a streamed reply.

Some models (DeepSeek R1 and the relays that front it) put the chain of
thought in the body instead of a separate field. SillyTavern calls that
reasoning_type "parsed" as opposed to "model"; we use the same two names so an
exported chat means the same thing on both sides.

The hard part is that chunk boundaries fall wherever the network feels like
it — "<thi" and "nk>" can arrive separately — so anything that could still
turn out to be the start of a tag is held back instead of emitted.
"""

OPEN_TAGS = ("<think>", "<thinking>")


def _hold_partial(buf: str, tags: tuple[str, ...]) -> tuple[str, str]:
    """Split buf into (safe to emit, hold back) at the longest trailing tag prefix."""
    longest = 0
    for tag in tags:
        for n in range(min(len(tag) - 1, len(buf)), 0, -1):
            if buf.endswith(tag[:n]):
                longest = max(longest, n)
                break
    if longest == 0:
        return buf, ""
    return buf[:-longest], buf[-longest:]


class ThinkTagSplitter:
    """Feed it streamed text, get back (body, reasoning) for each increment."""

    def __init__(self) -> None:
        self._buf = ""
        self._state = "seek"  # seek -> inside -> done
        self._close = ""
        self._emitted = False  # has any non-whitespace body gone out yet
        self.used = False  # True once a tag was actually found

    def feed(self, s: str) -> tuple[str, str]:
        self._buf += s
        text_out, reason_out = "", ""

        while True:
            if self._state == "seek":
                hit: tuple[int, str] | None = None
                for tag in OPEN_TAGS:
                    i = self._buf.find(tag)
                    if i != -1 and (hit is None or i < hit[0]):
                        hit = (i, tag)

                if hit is not None:
                    i, tag = hit
                    if self._buf[:i].strip():
                        # real prose came first — this is a literal tag, not a think block
                        self._state = "done"
                        continue
                    text_out += self._buf[:i]
                    self._buf = self._buf[i + len(tag) :]
                    self._close = "</" + tag[1:]
                    self._state = "inside"
                    self.used = True
                    continue

                safe, held = _hold_partial(self._buf, OPEN_TAGS)
                if safe.strip():
                    # prose that is not a tag prefix — no think block is coming
                    text_out += self._buf
                    self._buf = ""
                    self._state = "done"
                    break
                text_out += safe  # whitespace only
                self._buf = held
                break

            if self._state == "inside":
                i = self._buf.find(self._close)
                if i != -1:
                    reason_out += self._buf[:i]
                    self._buf = self._buf[i + len(self._close) :]
                    self._state = "done"
                    continue
                safe, held = _hold_partial(self._buf, (self._close,))
                reason_out += safe
                self._buf = held
                break

            text_out += self._buf
            self._buf = ""
            break

        return self._trim(text_out), reason_out

    def _trim(self, text: str) -> str:
        """The body never starts with whitespace — the indentation around a
        think tag is markup, not prose."""
        if not self._emitted:
            text = text.lstrip()
            if text:
                self._emitted = True
        return text

    def flush(self) -> tuple[str, str]:
        """Drain whatever is still held back. Call once the stream ends."""
        rest, self._buf = self._buf, ""
        if self._state == "inside":
            # tag never closed — the model ran out mid-thought, keep it as reasoning
            return "", rest
        self._state = "done"
        return self._trim(rest), ""
