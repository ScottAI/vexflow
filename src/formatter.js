// [VexFlow](http://vexflow.com) - Copyright (c) Mohit Muthanna 2010.
//
// ## Description
//
// This file implements the formatting and layout algorithms that are used
// to position notes in a voice. The algorithm can align multiple voices both
// within a stave, and across multiple staves.
//
// To do this, the formatter breaks up voices into a grid of rational-valued
// `ticks`, to which each note is assigned. Then, minimum widths are assigned
// to each tick based on the widths of the notes and modifiers in that tick. This
// establishes the smallest amount of space required for each tick.
//
// Finally, the formatter distributes the left over space proportionally to
// all the ticks, setting the `x` values of the notes in each tick.
//
// See `tests/formatter_tests.js` for usage examples. The helper functions included
// here (`FormatAndDraw`, `FormatAndDrawTab`) also serve as useful usage examples.

import { Vex } from './vex';
import { Flow } from './tables';
import { Fraction } from './fraction';
import { Voice } from './voice';
import { Beam } from './beam';
import { StaveConnector } from './staveconnector';
import { StaveNote } from './stavenote';
import { ModifierContext } from './modifiercontext';
import { TickContext } from './tickcontext';

// To enable logging for this class. Set `Vex.Flow.Formatter.DEBUG` to `true`.
function L(...args) { if (Formatter.DEBUG) Vex.L('Vex.Flow.Formatter', args); }

// Helper function to locate the next non-rest note(s).
function lookAhead(notes, restLine, i, compare) {
  // If no valid next note group, nextRestLine is same as current.
  let nextRestLine = restLine;

  // Get the rest line for next valid non-rest note group.
  for (i += 1; i < notes.length; i += 1) {
    const note = notes[i];
    if (!note.isRest() && !note.shouldIgnoreTicks()) {
      nextRestLine = note.getLineForRest();
      break;
    }
  }

  // Locate the mid point between two lines.
  if (compare && restLine !== nextRestLine) {
    const top = Math.max(restLine, nextRestLine);
    const bot = Math.min(restLine, nextRestLine);
    nextRestLine = Vex.MidLine(top, bot);
  }
  return nextRestLine;
}

// Take an array of `voices` and place aligned tickables in the same context. Returns
// a mapping from `tick` to `ContextType`, a list of `tick`s, and the resolution
// multiplier.
//
// Params:
// * `voices`: Array of `Voice` instances.
// * `ContextType`: A context class (e.g., `ModifierContext`, `TickContext`)
// * `addToContext`: Function to add tickable to context.
function createContexts(voices, ContextType, addToContext) {
  if (!voices || !voices.length) {
    throw new Vex.RERR('BadArgument', 'No voices to format');
  }

  // Find out highest common multiple of resolution multipliers.
  // The purpose of this is to find out a common denominator
  // for all fractional tick values in all tickables of all voices,
  // so that the values can be expanded and the numerator used
  // as an integer tick value.
  const totalTicks = voices[0].getTotalTicks();
  const resolutionMultiplier = voices.reduce((resolutionMultiplier, voice) => {
    if (!voice.getTotalTicks().equals(totalTicks)) {
      throw new Vex.RERR(
        'TickMismatch', 'Voices should have same total note duration in ticks.'
       );
    }

    if (voice.getMode() === Voice.Mode.STRICT && !voice.isComplete()) {
      throw new Vex.RERR(
        'IncompleteVoice', 'Voice does not have enough notes.'
      );
    }

    return Math.max(
      resolutionMultiplier,
      Fraction.LCM(resolutionMultiplier, voice.getResolutionMultiplier())
    );
  }, 1);

  // Initialize tick maps.
  const tickToContextMap = {};
  const tickList = [];
  const contexts = [];

  // For each voice, extract notes and create a context for every
  // new tick that hasn't been seen before.
  voices.forEach(voice => {
    // Use resolution multiplier as denominator to expand ticks
    // to suitable integer values, so that no additional expansion
    // of fractional tick values is needed.
    const ticksUsed = new Fraction(0, resolutionMultiplier);

    voice.getTickables().forEach(tickable => {
      const integerTicks = ticksUsed.numerator;

      // If we have no tick context for this tick, create one.
      if (!tickToContextMap[integerTicks]) {
        const newContext = new ContextType();
        contexts.push(newContext);
        tickToContextMap[integerTicks] = newContext;
      }

      // Add this tickable to the TickContext.
      addToContext(tickable, tickToContextMap[integerTicks]);

      // Maintain a sorted list of tick contexts.
      tickList.push(integerTicks);
      ticksUsed.add(tickable.getTicks());
    });
  });

  return {
    map: tickToContextMap,
    array: contexts,
    list: Vex.SortAndUnique(tickList, (a, b) => a - b, (a, b) => a === b),
    resolutionMultiplier,
  };
}

export class Formatter {
  // Helper function to layout "notes" one after the other without
  // regard for proportions. Useful for tests and debugging.
  static SimpleFormat(notes, x = 0) {
    notes.reduce((x, note) => {
      note.addToModifierContext(new ModifierContext());
      const tick = new TickContext().addTickable(note).preFormat();
      const extra = tick.getExtraPx();
      tick.setX(x + extra.left);

      return x + tick.getWidth() + extra.right + 10;
    }, x);
  }

  // Helper function to format and draw a single voice. Returns a bounding
  // box for the notation.
  //
  // Parameters:
  // * `ctx` - The rendering context
  // * `stave` - The stave to which to draw (`Stave` or `TabStave`)
  // * `notes` - Array of `Note` instances (`StaveNote`, `TextNote`, `TabNote`, etc.)
  // * `params` - One of below:
  //    * Setting `autobeam` only `(context, stave, notes, true)` or
  //      `(ctx, stave, notes, {autobeam: true})`
  //    * Setting `align_rests` a struct is needed `(context, stave, notes, {align_rests: true})`
  //    * Setting both a struct is needed `(context, stave, notes, {
  //      autobeam: true, align_rests: true})`
  //
  // `autobeam` automatically generates beams for the notes.
  // `align_rests` aligns rests with nearby notes.
  static FormatAndDraw(ctx, stave, notes, params) {
    const options = {
      auto_beam: false,
      align_rests: false,
    };

    if (typeof params === 'object') {
      Vex.Merge(options, params);
    } else if (typeof params === 'boolean') {
      options.auto_beam = params;
    }

    // Start by creating a voice and adding all the notes to it.
    const voice = new Voice(Flow.TIME4_4)
      .setMode(Voice.Mode.SOFT)
      .addTickables(notes);

    // Then create beams, if requested.
    const beams = options.auto_beam ? Beam.applyAndGetBeams(voice) : [];

    // Instantiate a `Formatter` and format the notes.
    new Formatter()
      .joinVoices([voice], { align_rests: options.align_rests })
      .formatToStave([voice], stave, { align_rests: options.align_rests, stave });

    // Render the voice and beams to the stave.
    voice.setStave(stave).draw(ctx, stave);
    beams.forEach(beam => beam.setContext(ctx).draw());

    // Return the bounding box of the voice.
    return voice.getBoundingBox();
  }

  // Helper function to format and draw aligned tab and stave notes in two
  // separate staves.
  //
  // Parameters:
  // * `ctx` - The rendering context
  // * `tabstave` - A `TabStave` instance on which to render `TabNote`s.
  // * `stave` - A `Stave` instance on which to render `Note`s.
  // * `notes` - Array of `Note` instances for the stave (`StaveNote`, `BarNote`, etc.)
  // * `tabnotes` - Array of `Note` instances for the tab stave (`TabNote`, `BarNote`, etc.)
  // * `autobeam` - Automatically generate beams.
  // * `params` - A configuration object:
  //    * `autobeam` automatically generates beams for the notes.
  //    * `align_rests` aligns rests with nearby notes.
  static FormatAndDrawTab(ctx, tabstave, stave, tabnotes, notes, autobeam, params) {
    const opts = {
      auto_beam: autobeam,
      align_rests: false,
    };

    if (typeof params === 'object') {
      Vex.Merge(opts, params);
    } else if (typeof params === 'boolean') {
      opts.auto_beam = params;
    }

    // Create a `4/4` voice for `notes`.
    const notevoice = new Voice(Flow.TIME4_4)
      .setMode(Voice.Mode.SOFT)
      .addTickables(notes);

    // Create a `4/4` voice for `tabnotes`.
    const tabvoice = new Voice(Flow.TIME4_4)
      .setMode(Voice.Mode.SOFT)
      .addTickables(tabnotes);

      // Then create beams, if requested.
    const beams = opts.auto_beam ? Beam.applyAndGetBeams(notevoice) : [];

    // Instantiate a `Formatter` and align tab and stave notes.
    new Formatter()
      .joinVoices([notevoice], { align_rests: opts.align_rests })
      .joinVoices([tabvoice])
      .formatToStave([notevoice, tabvoice], stave, { align_rests: opts.align_rests });

    // Render voices and beams to staves.
    notevoice.draw(ctx, stave);
    tabvoice.draw(ctx, tabstave);
    beams.forEach(beam => beam.setContext(ctx).draw());

    // Draw a connector between tab and note staves.
    new StaveConnector(stave, tabstave).setContext(ctx).draw();
  }

  // Auto position rests based on previous/next note positions.
  //
  // Params:
  // * `notes`: An array of notes.
  // * `alignAllNotes`: If set to false, only aligns non-beamed notes.
  // * `alignTuplets`: If set to false, ignores tuplets.
  static AlignRestsToNotes(notes, alignAllNotes, alignTuplets) {
    notes.forEach((note, index) => {
      if (note instanceof StaveNote && note.isRest()) {
        if (note.tuplet && !alignTuplets) return;

        // If activated rests not on default can be rendered as specified.
        const position = note.getGlyph().position.toUpperCase();
        if (position !== 'R/4' && position !== 'B/4') return;

        if (alignAllNotes || note.beam != null) {
          // Align rests with previous/next notes.
          const props = note.getKeyProps()[0];
          if (index === 0) {
            props.line = lookAhead(notes, props.line, index, false);
            note.setKeyLine(0, props.line);
          } else if (index > 0 && index < notes.length) {
            // If previous note is a rest, use its line number.
            let restLine;
            if (notes[index - 1].isRest()) {
              restLine = notes[index - 1].getKeyProps()[0].line;
              props.line = restLine;
            } else {
              restLine = notes[index - 1].getLineForRest();
              // Get the rest line for next valid non-rest note group.
              props.line = lookAhead(notes, restLine, index, true);
            }
            note.setKeyLine(0, props.line);
          }
        }
      }
    });

    return this;
  }

  constructor() {
    // Minimum width required to render all the notes in the voices.
    this.minTotalWidth = 0;

    // This is set to `true` after `minTotalWidth` is calculated.
    this.hasMinTotalWidth = false;

    // Total number of ticks in the voice.
    this.totalTicks = new Fraction(0, 1);

    // Arrays of tick and modifier contexts.
    this.tickContexts = null;
    this.modiferContexts = null;
  }

  // Find all the rests in each of the `voices` and align them
  // to neighboring notes. If `alignAllNotes` is `false`, then only
  // align non-beamed notes.
  alignRests(voices, alignAllNotes) {
    if (!voices || !voices.length) {
      throw new Vex.RERR('BadArgument', 'No voices to format rests');
    }

    voices.forEach(voice =>
      Formatter.AlignRestsToNotes(voice.getTickables(), alignAllNotes));
  }

  // Calculate the minimum width required to align and format `voices`.
  preCalculateMinTotalWidth(voices) {
    // Cache results.
    if (this.hasMinTotalWidth) return this.minTotalWidth;

    // Create tick contexts if not already created.
    if (!this.tickContexts) {
      if (!voices) {
        throw new Vex.RERR(
          'BadArgument', "'voices' required to run preCalculateMinTotalWidth"
        );
      }

      this.createTickContexts(voices);
    }

    const { list: contextList, map: contextMap } = this.tickContexts;

    // Go through each tick context and calculate total width.
    this.minTotalWidth = contextList
      .map(tick => {
        const context = contextMap[tick];
        context.preFormat();
        return context.getWidth();
      })
      .reduce((a, b) => a + b, 0);

    this.hasMinTotalWidth = true;

    return this.minTotalWidth;
  }

  // Get minimum width required to render all voices. Either `format` or
  // `preCalculateMinTotalWidth` must be called before this method.
  getMinTotalWidth() {
    if (!this.hasMinTotalWidth) {
      throw new Vex.RERR(
        'NoMinTotalWidth',
        "Call 'preCalculateMinTotalWidth' or 'preFormat' before calling 'getMinTotalWidth'"
      );
    }

    return this.minTotalWidth;
  }

  // Create `ModifierContext`s for each tick in `voices`.
  createModifierContexts(voices) {
    const contexts = createContexts(
      voices,
      ModifierContext,
      (tickable, context) => tickable.addToModifierContext(context)
    );

    this.modiferContexts = contexts;
    return contexts;
  }

  // Create `TickContext`s for each tick in `voices`. Also calculate the
  // total number of ticks in voices.
  createTickContexts(voices) {
    const contexts = createContexts(
      voices,
      TickContext,
      (tickable, context) => context.addTickable(tickable)
    );

    contexts.array.forEach(context => {
      context.tContexts = contexts.array;
    });

    this.totalTicks = voices[0].getTicksUsed().clone();
    this.tickContexts = contexts;
    return contexts;
  }

  // This is the core formatter logic. Format voices and justify them
  // to `justifyWidth` pixels. `renderingContext` is required to justify elements
  // that can't retreive widths without a canvas. This method sets the `x` positions
  // of all the tickables/notes in the formatter.
  preFormat(justifyWidth = 0, renderingContext, voices, stave) {
    // Initialize context maps.
    const contexts = this.tickContexts;
    const { list: contextList, map: contextMap, resolutionMultiplier } = contexts;

    // If voices and a stave were provided, set the Stave for each voice
    // and preFormat to apply Y values to the notes;
    if (voices && stave) {
      voices.forEach(voice => voice.setStave(stave).preFormat());
    }

    // Now distribute the ticks to each tick context, and assign them their
    // own X positions.
    let x = 0;
    let shift = 0;
    const centerX = justifyWidth / 2;
    this.minTotalWidth = 0;

    // Pass 1: Give each note maximum width requested by context.
    contextList.forEach((tick) => {
      const context = contextMap[tick];
      if (renderingContext) context.setContext(renderingContext);

      // Make sure that all tickables in this context have calculated their
      // space requirements.
      context.preFormat();

      const width = context.getWidth();
      this.minTotalWidth += width;

      const extra = context.getExtraPx();
      x = x + shift + extra.left + extra.extraLeft;
      context.setX(x);

      // Calculate shift for the next tick.
      shift = context.getWidth() - (extra.left + extra.extraLeft);
    });

    this.minTotalWidth = x + shift;
    this.hasMinTotalWidth = true;

    if (justifyWidth > 0) {
      // Pass 2: Take leftover width, and distribute it to proportionately to
      // all notes.
      const remainingX = justifyWidth - this.minTotalWidth;
      const leftoverPxPerTick = remainingX / (this.totalTicks.value() * resolutionMultiplier);
      let spaceAccum = 0;

      contextList.forEach((tick, index) => {
        const prevTick = contextList[index - 1] || 0;
        const context = contextMap[tick];
        const tickSpace = (tick - prevTick) * leftoverPxPerTick;
        spaceAccum += tickSpace;

        context.setX(context.getX() + spaceAccum);

        // Move center aligned tickables to middle
        context
          .getCenterAlignedTickables()
          .forEach(tickable => { // eslint-disable-line
            tickable.center_x_shift = centerX - context.getX();
          });
      });
    }
  }

  // This is the top-level call for all formatting logic completed
  // after `x` *and* `y` values have been computed for the notes
  // in the voices.
  postFormat() {
    const postFormatContexts = (contexts) =>
      contexts.list.forEach(tick => contexts.map[tick].postFormat());

    postFormatContexts(this.modiferContexts);
    postFormatContexts(this.tickContexts);

    return this;
  }

  // Take all `voices` and create `ModifierContext`s out of them. This tells
  // the formatters that the voices belong on a single stave.
  joinVoices(voices) {
    this.createModifierContexts(voices);
    this.hasMinTotalWidth = false;
    return this;
  }

  // Align rests in voices, justify the contexts, and position the notes
  // so voices are aligned and ready to render onto the stave. This method
  // mutates the `x` positions of all tickables in `voices`.
  //
  // Voices are full justified to fit in `justifyWidth` pixels.
  //
  // Set `options.context` to the rendering context. Set `options.align_rests`
  // to true to enable rest alignment.
  format(voices, justifyWidth, options) {
    const opts = {
      align_rests: false,
      context: null,
      stave: null,
    };

    Vex.Merge(opts, options);
    this.alignRests(voices, opts.align_rests);
    this.createTickContexts(voices);
    this.preFormat(justifyWidth, opts.context, voices, opts.stave);

    // Only postFormat if a stave was supplied for y value formatting
    if (opts.stave) this.postFormat();

    return this;
  }

  // This method is just like `format` except that the `justifyWidth` is inferred
  // from the `stave`.
  formatToStave(voices, stave, options) {
    const justifyWidth = stave.getNoteEndX() - stave.getNoteStartX() - 10;
    L('Formatting voices to width: ', justifyWidth);
    const opts = { context: stave.getContext() };
    Vex.Merge(opts, options);
    return this.format(voices, justifyWidth, opts);
  }
}
