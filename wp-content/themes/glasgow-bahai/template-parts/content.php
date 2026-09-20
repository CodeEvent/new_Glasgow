<?php
/**
 * Template part for displaying posts (index/archive/single).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
<article id="post-<?php the_ID(); ?>" <?php post_class( 'content-wrap' ); ?>>
	<?php if ( ! is_singular() ) : ?>
		<h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
	<?php endif; ?>

	<?php glasgow_bahai_posted_on(); ?>

	<?php if ( has_post_thumbnail() && ! is_singular() ) : ?>
		<a href="<?php the_permalink(); ?>"><?php the_post_thumbnail( 'glasgow-bahai-card' ); ?></a>
	<?php elseif ( has_post_thumbnail() ) : ?>
		<?php the_post_thumbnail( 'large' ); ?>
	<?php endif; ?>

	<div class="entry-content">
		<?php
		if ( is_singular() ) {
			the_content();
		} else {
			the_excerpt();
		}
		?>
	</div>
</article>
