-- a11y-enhance.lua
-- Two build-time accessibility enhancements for the generated HTML.
--
-- 1. Code blocks in a <blockquote>. A bare <pre> is not announced as a distinct
--    region by screen readers and cannot be jumped to, whereas a <blockquote> is
--    announced and is navigable (e.g. the "q" quick key). So every code block is
--    wrapped in <blockquote aria-roledescription="code block">, which a screen
--    reader speaks as "code block" rather than "quote" while keeping the blockquote
--    navigation. The copy button (added by the page script) still targets the inner
--    <pre>, so it is unaffected.
--
-- 2. Footer Previous/Next access keys. The numbered guides end with a footer line
--    "Previous: <link> | Next: <link>". We set accesskey="p"/"n" on those two links so
--    a keyboard user can jump between guides. We deliberately do NOT set
--    aria-keyshortcuts: the actual modifier combo is chosen by the browser/OS (Chrome
--    Alt+P, Firefox Alt+Shift+P, Safari Ctrl+Alt+P, ...), so advertising one fixed combo
--    would mislead assistive tech. The browser exposes the real accesskey shortcut to AT.

-- Wrap each code block in an announced blockquote.
function CodeBlock(el)
  local open = pandoc.RawBlock(
    'html',
    '<blockquote class="code-block" aria-roledescription="code block">'
  )
  local close = pandoc.RawBlock('html', '</blockquote>')
  return { open, el, close }
end

-- The first non-space inline of a paragraph, or nil for an empty paragraph.
local function first_inline(inlines)
  for _, il in ipairs(inlines) do
    if il.t ~= 'Space' and il.t ~= 'SoftBreak' and il.t ~= 'LineBreak' then
      return il
    end
  end
  return nil
end

-- Tag the footer's Previous/Next links with access keys. A footer paragraph is one
-- whose first inline is the literal "Previous:" or "Next:" (body prose never starts
-- that way), so ordinary paragraphs are left untouched.
function Para(el)
  local first = first_inline(el.content)
  if not first or first.t ~= 'Str' then
    return nil
  end
  if first.text ~= 'Previous:' and first.text ~= 'Next:' then
    return nil
  end

  local mode = nil
  for _, il in ipairs(el.content) do
    if il.t == 'Str' then
      if il.text == 'Previous:' then
        mode = 'p'
      elseif il.text == 'Next:' then
        mode = 'n'
      end
    elseif il.t == 'Link' and mode then
      il.attributes['accesskey'] = mode
      mode = nil
    end
  end
  return el
end
