import '../components-wokwi/RaspberryPi3Element';

interface RaspberryPi3Props {
  id?: string;
  x?: number;
  y?: number;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'wokwi-raspberry-pi-3': any;
    }
  }
}

export const RaspberryPi3 = ({ id = 'raspberry-pi-3', x = 0, y = 0 }: RaspberryPi3Props) => (
  <wokwi-raspberry-pi-3
    id={id}
    style={{ position: 'absolute', left: `${x}px`, top: `${y}px` }}
  />
);
