<?php
/**
 * Custom template tags for this theme.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! function_exists( 'glasgow_bahai_emblem' ) ) {
	/**
	 * Outputs the nine-pointed star emblem used in the header/footer.
	 */
	function glasgow_bahai_emblem( $class = 'site-emblem' ) {
		?>
		<svg class="<?php echo esc_attr( $class ); ?>" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<?php for ( $i = 0; $i < 9; $i++ ) :
				$angle = $i * 40 - 90;
				$x     = 50 + 42 * cos( deg2rad( $angle ) );
				$y     = 50 + 42 * sin( deg2rad( $angle ) );
				?>
				<line x1="50" y1="50" x2="<?php echo esc_attr( round( $x, 2 ) ); ?>" y2="<?php echo esc_attr( round( $y, 2 ) ); ?>" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
			<?php endfor; ?>
			<circle cx="50" cy="50" r="10" fill="currentColor" />
		</svg>
		<?php
	}
}

if ( ! function_exists( 'glasgow_bahai_posted_on' ) ) {
	/**
	 * Prints published date for a post.
	 */
	function glasgow_bahai_posted_on() {
		printf(
			'<span class="posted-on">%s</span>',
			esc_html( get_the_date() )
		);
	}
}
