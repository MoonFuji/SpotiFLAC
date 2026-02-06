'use client';
import type { Variants } from 'motion/react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { motion, useAnimation } from 'motion/react';
import { cn } from '@/lib/utils';

export interface TrendingUpIconHandle {
    startAnimation: () => void;
    stopAnimation: () => void;
}

interface TrendingUpIconProps extends HTMLAttributes<HTMLDivElement> {
    size?: number;
}

const PATH_VARIANTS: Variants = {
    normal: {
        pathLength: 1,
        opacity: 1,
        pathOffset: 0,
    },
    animate: {
        pathLength: [0, 1],
        opacity: [0, 1],
        pathOffset: [1, 0],
        transition: {
            duration: 0.6,
            ease: 'easeInOut',
        },
    },
};

const ARROW_VARIANTS: Variants = {
    normal: {
        x: 0,
        y: 0,
        opacity: 1,
    },
    animate: {
        x: [0, 2, 0],
        y: [0, -2, 0],
        opacity: [1, 0.8, 1],
        transition: {
            duration: 0.6,
            ease: 'easeInOut',
        },
    },
};

const TrendingUpIcon = forwardRef<TrendingUpIconHandle, TrendingUpIconProps>(
    ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
        const controls = useAnimation();
        const isControlledRef = useRef(false);

        useImperativeHandle(ref, () => {
            isControlledRef.current = true;
            return {
                startAnimation: () => controls.start('animate'),
                stopAnimation: () => controls.start('normal'),
            };
        });

        const handleMouseEnter = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                if (!isControlledRef.current) {
                    controls.start('animate');
                } else {
                    onMouseEnter?.(e);
                }
            },
            [controls, onMouseEnter]
        );

        const handleMouseLeave = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                if (!isControlledRef.current) {
                    controls.start('normal');
                } else {
                    onMouseLeave?.(e);
                }
            },
            [controls, onMouseLeave]
        );

        return (
            <div
                className={cn(className)}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                {...props}
            >
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width={size}
                    height={size}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <motion.polyline
                        points="22 7 13.5 15.5 8.5 10.5 2 17"
                        variants={PATH_VARIANTS}
                        animate={controls}
                        initial="normal"
                    />
                    <motion.polyline
                        points="16 7 22 7 22 13"
                        variants={ARROW_VARIANTS}
                        animate={controls}
                        initial="normal"
                    />
                </svg>
            </div>
        );
    }
);

TrendingUpIcon.displayName = 'TrendingUpIcon';

export { TrendingUpIcon };
