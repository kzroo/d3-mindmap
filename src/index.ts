import { hierarchy, tree as createTree, HierarchyPointNode } from 'd3-hierarchy';
import { select } from 'd3-selection';
import { scaleOrdinal } from 'd3-scale';
import { zoom, zoomIdentity } from 'd3-zoom';
import 'd3-transition';

type ThemeColor = string | { light: string; dark: string };

interface MindMapData {
  name: string;
  children?: MindMapData[];
  color?: ThemeColor;
  size?: number;
  collapsed?: boolean;
}

interface NodeInfo {
  label: string;
  depth: number;
  data: MindMapData;
}

interface ThemeColors {
  nodeColors: string[];
  linkColor: string;
  textColor: string;
  bgColor: string;
}

type Theme = 'light' | 'dark';

const THEMES: Record<Theme, ThemeColors> = {
  light: {
    nodeColors: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    linkColor: '#ccc',
    textColor: '#333',
    bgColor: '#fff',
  },
  dark: {
    nodeColors: ['#4dabf7', '#ffa94d', '#69db7c', '#ff6b6b', '#da77f2', '#e599f7', '#fcc2d7', '#adb5bd', '#ffe066', '#66d9e8'],
    linkColor: '#495057',
    textColor: '#e9ecef',
    bgColor: '#1a1a1a',
  }
};

interface Options {
  colorSet?: string[];
  defaultNodeSize?: number;
  theme?: Theme;
  onLabelClick?: (node: NodeInfo) => void;
  onToggleClick?: (node: NodeInfo) => void;
}

interface Axis {
  x: number;
  y: number;
}

// MNode: D3 hierarchy node with layout coordinates and toggle state
type MNode = HierarchyPointNode<MindMapData> & {
  x0: number;
  y0: number;
  _children?: MNode[] | null;
};

function diagonal(s: Axis, d: Axis) {
  return `M ${s.y} ${s.x}
    C ${(s.y + d.y) / 2} ${s.x},
      ${(s.y + d.y) / 2} ${d.x},
      ${d.y} ${d.x}`;
}

const resolveColor = (color: ThemeColor | undefined, theme: Theme): string | undefined => {
  if (!color) return undefined;
  if (typeof color === 'string') return color;
  return color[theme];
};

export default function getRender(container: HTMLElement, options: Options = {}) {
  const defaultNodeSize = options.defaultNodeSize ?? 4.5;
  let theme: Theme = options.theme || 'light';

  const svg = select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .style('overflow', 'scroll')
    .style('background', THEMES[theme].bgColor);
  const svgGroup = svg.append('g');

  // Read dimensions dynamically for resize support
  const getDimensions = () => ({
    width: container.clientWidth,
    height: container.clientHeight
  });

  const colorSet = options.colorSet || THEMES[theme].nodeColors;
  const color = scaleOrdinal(colorSet);

  let root: MNode | undefined;
  let nodeId = 0;

  const zoomBehavior = zoom<SVGSVGElement, unknown>().on('zoom', ev => {
    svgGroup.attr('transform', ev.transform);
  });
  svg.call(zoomBehavior);

  const getNodeColor = (d: MNode): string =>
    resolveColor(d.data.color, theme) || color(String(d.depth));

  const getNodeSize = (d: MNode): number => d.data.size ?? defaultNodeSize;

  function centerContent(nodes: MNode[], animate = true) {
    if (nodes.length === 0) return;

    const { width } = getDimensions();
    const minY = Math.min(...nodes.map(d => d.y));
    const maxY = Math.max(...nodes.map(d => d.y));
    const treeWidth = maxY - minY;
    const centerX = (width - treeWidth) / 2 - minY;

    const transform = zoomIdentity.translate(centerX, 0);
    if (animate) {
      svg.transition()
        .duration(750)
        .call(zoomBehavior.transform, transform);
    } else {
      svg.call(zoomBehavior.transform, transform);
    }
  }

  function update(source: MNode) {
    if (!root) return;

    const { width, height } = getDimensions();
    const tree = createTree<MindMapData>().size([height, width]);
    const treeData = tree(root);
    const nodes = treeData.descendants() as MNode[];
    const links = treeData.links();

    nodes.forEach(d => { d.y = d.depth * 180; });

    const node = svgGroup.selectAll<SVGGElement, MNode>('.node')
      .data(nodes, (d: MNode & { _id?: number }): number => d._id || (d._id = ++nodeId));

    const nodeEnter = node.enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', () => `translate(${source.y0}, ${source.x0})`);

    nodeEnter.append('circle')
      .attr('r', 1e-6)
      .style('fill', d => color(String(d.depth)))
      .style('cursor', 'pointer')
      .style('stroke', '#fff')
      .style('stroke-width', '1.5px');

    nodeEnter.append('text')
      .attr('dx', d => d.children ? -12 : 12)
      .attr('dy', 3)
      .style('text-anchor', d => d.children ? 'end' : 'start')
      .style('font-size', '10px')
      .style('font-family', 'sans-serif')
      .style('cursor', 'pointer')
      .text(d => d.data.name);

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.transition()
      .duration(750)
      .attr('transform', d => `translate(${d.y}, ${d.x})`);

    nodeUpdate.select('circle')
      .attr('r', getNodeSize)
      .style('fill', getNodeColor)
      .on('click', nodeClicked);

    nodeUpdate.select('text')
      .attr('dx', d => d.children ? -12 : 12)
      .attr('dy', 3)
      .style('text-anchor', d => d.children ? 'end' : 'start')
      .style('fill', THEMES[theme].textColor)
      .style('cursor', 'pointer')
      .text(d => d.data.name)
      .on('click', labelClicked);

    const nodeExit = node.exit()
      .transition()
      .duration(750)
      .attr('transform', () => `translate(${source.y}, ${source.x})`)
      .remove();

    nodeExit.select('circle').attr('r', 1e-6);
    nodeExit.select('text').style('fill-opacity', 1e-6);

    const link = svgGroup.selectAll<SVGPathElement, typeof links[0]>('.link')
      .data(links, d => (d.target as MNode & { _id?: number })._id!);

    const linkEnter = link.enter().insert('path', 'g')
      .attr('class', 'link')
      .attr('d', () => {
        const o = { x: source.x0, y: source.y0 };
        return diagonal(o, o);
      })
      .style('fill', 'none')
      .style('stroke', THEMES[theme].linkColor)
      .style('stroke-width', '1.5px');

    linkEnter.merge(link)
      .transition()
      .duration(750)
      .attr('d', d => diagonal(d.source as Axis, d.target as Axis));

    link.exit().transition()
      .duration(750)
      .attr('d', () => {
        const o = { x: source.x, y: source.y };
        return diagonal(o, o);
      })
      .remove();

    nodes.forEach(d => {
      d.x0 = d.x;
      d.y0 = d.y;
    });

    // Center content after layout update
    centerContent(nodes);

    function nodeClicked(event: MouseEvent, d: MNode) {
      event.stopPropagation();
      if (d.children) {
        d._children = d.children as MNode[];
        d.children = undefined;
      } else {
        d.children = (d._children as MNode[]) ?? undefined;
        d._children = null;
      }
      update(d);
      options.onToggleClick?.({ label: d.data.name, depth: d.depth, data: d.data });
    }

    function labelClicked(event: MouseEvent, d: MNode) {
      event.stopPropagation();
      if (d.children) {
        d._children = d.children as MNode[];
        d.children = undefined;
      } else {
        d.children = (d._children as MNode[]) ?? undefined;
        d._children = null;
      }
      update(d);
      options.onLabelClick?.({ label: d.data.name, depth: d.depth, data: d.data });
    }
  }

  function applyCollapsedStates(node: MNode) {
    if (node.children) {
      (node.children as MNode[]).forEach(applyCollapsedStates);
      if (node.data.collapsed) {
        node._children = node.children as MNode[];
        node.children = undefined;
      }
    }
  }

  function setTheme(newTheme: Theme) {
    theme = newTheme;
    svg.style('background', THEMES[theme].bgColor);
    svgGroup.selectAll('.link').style('stroke', THEMES[theme].linkColor);
    svgGroup.selectAll('.node text').style('fill', THEMES[theme].textColor);
    svgGroup.selectAll<SVGCircleElement, MNode>('.node circle').style('fill', getNodeColor);
  }

  function resize() {
    if (root) update(root);
  }

  return function (data: MindMapData) {
    const { height } = getDimensions();
    root = hierarchy(data) as unknown as MNode;
    root.x0 = height / 2;
    root.y0 = 0;
    applyCollapsedStates(root);
    update(root);

    // Center immediately on initial render (no animation)
    const { width, height: h } = getDimensions();
    const tree = createTree<MindMapData>().size([h, width]);
    const treeData = tree(root);
    const nodes = treeData.descendants() as MNode[];
    nodes.forEach(d => { d.y = d.depth * 180; });
    centerContent(nodes, false);

    return { root, svg, svgGroup, setTheme, resize };
  };
}
