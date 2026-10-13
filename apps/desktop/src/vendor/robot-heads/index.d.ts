import { CSSProperties } from 'react';
import { ForwardRefExoticComponent } from 'react';
import { HTMLAttributes } from 'react';
import { RefAttributes } from 'react';

/**
 * A TV-headed robot: a glossy moulded shell with knob ears and an
 * antenna, and an LED matrix for a face that shows what it is doing.
 *
 * The element is a `size` × `size` box with the robot at rest centred
 * in it. Its canvas reaches past the box, so hops, the antenna's glow and
 * the floor's shadow draw outside it without taking part in layout.
 */
export declare const RobotHead: ForwardRefExoticComponent<RobotHeadProps & RefAttributes<HTMLCanvasElement>>;

/** The head's build. Only the TV head so far. */
export declare type RobotHeadModel = 'tv';

/**
 * Any other attribute (`className`, `style`, `onClick`, `aria-label`, …)
 * goes on the element: the `size` × `size` box the robot rests in. A `ref`
 * reaches the canvas inside it.
 */
export declare interface RobotHeadProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'color'> {
    /** Which head. Default `tv`. */
    model?: RobotHeadModel;
    /** The head's outline: `rectangle` (default), `square`, `circle` or `hexagon`. */
    shape?: RobotHeadShape;
    /** What it is doing. Default `idle`. */
    state?: RobotHeadState;
    /** The box the robot rests in, in px; hops and the glow reach past it. Default `160`. */
    size?: number;
    /** Colour of the shell. Default a deep glossy blue. */
    color?: string;
    /** Colour of the ears and the antenna's collar. Default a pale steel. */
    trimColor?: string;
    /** Colour of the LEDs on the screen. Default a cool white. */
    screenColor?: string;
    /** Multiplier on every animation's speed. Default `1`. */
    speed?: number;
    /** Freeze every animation on its current frame. */
    paused?: boolean;
    /** Follow the pointer with the eyes and head, and hop and spin on a click. Default `true`. */
    interactive?: boolean;
    /**
     * Show the antenna's stem and its light. Default `true`. Turn it off for
     * small sizes, such as avatars in a list: the knob on top stays, and the
     * head grows to fill the room the antenna took.
     */
    antenna?: boolean;
    /** Draw the soft shadow on the floor under the head. Default `true`. */
    floorShadow?: boolean;
    /** 0–1, offsets the blinks and glances so a row of heads does not move in unison. */
    seed?: number;
    className?: string;
    style?: CSSProperties;
}

/** The outline of the head, seen from the front. Every shape carries the same screen, ears and antenna. */
export declare type RobotHeadShape = 'rectangle' | 'square' | 'circle' | 'hexagon';

export declare const robotHeadShapes: RobotHeadShape[];

/** What the robot is doing: each state has its own face on the screen, its own motion and its own antenna light. */
export declare type RobotHeadState = 'idle' | 'thinking' | 'searching' | 'listening' | 'speaking' | 'working' | 'happy' | 'error' | 'sleeping';

export declare const robotHeadStates: RobotHeadState[];

export { }
