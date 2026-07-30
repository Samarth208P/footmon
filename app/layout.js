import "./globals.css";

export const metadata = {
  title: "FootMon — World Cup Squad Builder on Monad",
  description:
    "Build your dream World Cup squad, compete on-chain, and win MON prizes every hour on Monad Testnet.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                var attrNames = ["bis_skin_checked", "bis_register", "cz-shortcut-listen"];
                var attrPrefixes = ["processed_"];

                function shouldStrip(name) {
                  if (!name) return false;
                  if (attrNames.indexOf(name) !== -1) return true;
                  for (var i = 0; i < attrPrefixes.length; i++) {
                    if (name.indexOf(attrPrefixes[i]) === 0) return true;
                  }
                  return false;
                }

                function cleanAttributes(root) {
                  if (!root || !root.querySelectorAll) return;
                  var nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
                  for (var i = 0; i < nodes.length; i++) {
                    var node = nodes[i];
                    if (!node || !node.getAttributeNames) continue;
                    var names = node.getAttributeNames();
                    for (var j = 0; j < names.length; j++) {
                      var name = names[j];
                      if (shouldStrip(name)) node.removeAttribute(name);
                    }
                  }
                }

                var originalSetAttribute = Element.prototype.setAttribute;
                Element.prototype.setAttribute = function (name, value) {
                  if (shouldStrip(name)) return;
                  return originalSetAttribute.call(this, name, value);
                };

                cleanAttributes(document.documentElement);

                var observer = new MutationObserver(function (mutations) {
                  for (var i = 0; i < mutations.length; i++) {
                    var mutation = mutations[i];
                    if (mutation.type === "attributes") {
                      if (mutation.target && shouldStrip(mutation.attributeName)) {
                        mutation.target.removeAttribute(mutation.attributeName);
                      }
                    }

                    if (mutation.type === "childList") {
                      for (var j = 0; j < mutation.addedNodes.length; j++) {
                        var added = mutation.addedNodes[j];
                        if (added && added.nodeType === 1) cleanAttributes(added);
                      }
                    }
                  }
                });

                observer.observe(document.documentElement, {
                  subtree: true,
                  childList: true,
                  attributes: true,
                  attributeFilter: attrNames
                });

                document.addEventListener("DOMContentLoaded", function () {
                  cleanAttributes(document.documentElement);
                });
              })();
            `,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700;900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
