"use strict";

const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("chrome://domfuzzhelper/content/file.jsm");

// content script for e10s support

// This is a frame script, so it may be running in a content process.
// In any event, it is targeted at a specific "tab", so we listen for
// the DOMWindowCreated event to be notified about content windows
// being created in this context.

function DOMFuzzInjector() {
  addEventListener("DOMWindowCreated", this, false);
}

DOMFuzzInjector.prototype = {
  handleEvent: function handleEvent(aEvent) {
    var window = aEvent.target.defaultView;

    // "DOMWindowCreated" is too early to inject <script> elements (there is no document.documentElement)
    // "load" is too late to trigger some bugs (see bug 790252 comment 5)
    window.addEventListener("DOMContentLoaded", maybeInjectScript, false);
  }
};

var injector = new DOMFuzzInjector();


/*************************
 * FUZZ SCRIPT INJECTION *
 *************************/


function maybeInjectScript(event)
{
  var doc = event.originalTarget;
  if (doc.nodeName != "#document") {
    return;
  }

  if (doc.location === null) {
    // Some weird situation with iframes and document.write and navigation can trigger this.
    return;
  }

  var hash = doc.location.hash;
  if (!hash.startsWith("#fuzz=")) {
    return;
  }

  if (ensurePrimay(doc)) {
    var fuzzSettings = hash.slice(6).split(",").map(function(s) { return parseInt(s); });
    injectScript(doc, fuzzSettings);
  }
}

function ensurePrimay(doc)
{
  // Avoid injecting the fuzz script multiple times. That would cause irreducible chaos.

  // (It would be conceptually simpler to have the rule be
  // "it must be the first document ever loaded",
  // but I can't think of a way to do that without lots of sync IPC messages.)

  var win = doc.defaultView;

  if (win !== win.top) {
    return false;
  }

  if (win.opener !== null) {
    return false;
  }

  if (win.history.length > 1) {
    // If we intentionally navigated forward and back but bfcache failed,
    // or we accidentally navigated to the same or similar URL,
    // then we not only want to avoid injecting the script but also
    // want to avoid wasting time sitting here.
    dumpln("Quitting because we tried to inject a fuzz script into a page with history.");
    sendAsyncMessage('DOMFuzzHelper.quitApplicationSoon', {}); // !!!
    return false;
  }

  return true;
}


function injectScript(doc, fuzzSettings)
{
  var domFuzzerScript = getEnv("DOM_FUZZER_SCRIPT");
  if (!domFuzzerScript) {
    return;
  }

  var scriptToInject =
    (readFile(fileObject(domFuzzerScript)) + "\n"
  + "document.getElementById('fuzz1').parentNode.removeChild(document.getElementById('fuzz1'));\n"
  + "fuzzSettings = [" + fuzzSettings.join(",") + "];\n"
  + "fuzzOnload();\n");

  var insertionPoint = doc.getElementsByTagName("head")[0] || doc.documentElement;
  if (!insertionPoint) {
    return;
  }

  var script = doc.createElementNS("http://www.w3.org/1999/xhtml", "script");
  script.setAttribute("id", "fuzz1");
  script.setAttribute("type", "text/javascript;version=1.7");
  script.textContent = scriptToInject;
  insertionPoint.appendChild(script);
}
